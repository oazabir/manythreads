import { randomBytes } from 'node:crypto';
import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { BotsBotLoadedEvent, BotsBotRemovedEvent } from '@manythreads/shared';
import { z } from 'zod';
import { APPLY_CONFIG_QUEUE, BOOT_HEAL_QUEUE, RECONCILE_QUEUE, SYNC_KEY_QUEUE, gatewayFromEnv } from './gateway.ts';
import type { KeyRow } from './rows.ts';

// The key half of the gateway (PLAN P5-06: "virtual key per bot, minted and deleted with it"). A bot's runtime presents its
// key; the key is registered with LiteLLM so usage and budgets (P5-07) can be attributed. Keys are minted by the
// `bots.bot.loaded` event and revoked by `bots.bot.removed`, both through a job: the event subscriber runs in the outbox
// transaction, and a network call has no business in one. A daily reconcile mints what is missing, revokes what is orphaned
// and re-pushes the config, so a dead-lettered job self-heals.

/** The key's visible head: `sk-` plus the first 8 characters — enough for the workspace page, useless as a credential. */
const PREFIX_LENGTH = 11;

/** 192 random bits in base64url, `sk-` prefixed: unguessable, and caller-chosen at `/key/generate` so runtime and proxy agree. */
export function newBotKey(): string {
  return `sk-${randomBytes(24).toString('base64url')}`;
}

/** The stored, non-secret head of a key. */
export const keyPrefix = (key: string): string => key.slice(0, PREFIX_LENGTH);

/**
 * The aliases a bot's key may call: what its BOT.md names (`bots.model_aliases`: `model.aliases`, then `model.fallbacks`)
 * that the workspace has bound, plus the fallback chains of those (the proxy retries a failed call on them, so the key must
 * reach them too). Never the workspace's whole set — a bot cannot be handed an alias its definition never asked for — and an
 * empty answer means the bot can call nothing yet, which `syncBotKey` treats as "no key", because the proxy reads an empty
 * list as "every model".
 */
export async function botKeyModels(tx: PluginTx, workspaceId: string, botId: string): Promise<string[]> {
  const bot = (
    await tx.query<{ model_aliases: string[] }>('SELECT model_aliases FROM app.bots WHERE id = $1 AND workspace_id = $2', [botId, workspaceId])
  ).rows[0];
  if (!bot || bot.model_aliases.length === 0) return [];
  const bound = new Map(
    (await tx.query<{ alias: string; fallbacks: string[] }>('SELECT alias, fallbacks FROM app.llm_aliases WHERE workspace_id = $1', [workspaceId])).rows.map(
      (r) => [r.alias, r.fallbacks] as const,
    ),
  );
  const models: string[] = [];
  const visit = (alias: string): void => {
    if (!bound.has(alias) || models.includes(alias)) return;
    models.push(alias);
    for (const next of bound.get(alias) ?? []) visit(next);
  };
  for (const alias of bot.model_aliases) visit(alias);
  return models;
}

/** What `syncBotKey` did, so a caller (and a log line) can say it. */
export type KeySyncResult = 'minted' | 'updated' | 'healed' | 'unchanged' | 'skipped' | 'revoked';

/**
 * Bring one bot's key in line with what its definition and the workspace's aliases allow: mint it when there is something it
 * may call, change the proxy's list when that set moved, and take it away when the set emptied. Idempotent, so an event
 * replay, a config push and the daily reconcile all call it. The proxy call happens before the row's write commits, so a
 * failure rolls everything back and the job retries; the key is caller-chosen, so a retry is harmless.
 */
export async function syncBotKey(ctx: PluginContext, tx: PluginTx, workspaceId: string, botId: string): Promise<KeySyncResult> {
  // One sync per bot at a time: two jobs (an event replay and the config push, or the reconcile) that both saw "no key" would
  // each mint one — a secret nobody references and a second key at the proxy. The second waits here for the first to commit and
  // then reads its row, so it finds the key and changes nothing. Released with the transaction.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('llm-key:' || $1::text))`, [botId]);
  const models = await botKeyModels(tx, workspaceId, botId);
  const existing = (
    await tx.query<{ secret_id: string | null; revoked_at: Date | null; models: string[] }>(
      'SELECT secret_id, revoked_at, models FROM app.llm_keys WHERE bot_id = $1',
      [botId],
    )
  ).rows[0];
  const live = existing !== undefined && existing.revoked_at === null && existing.secret_id !== null;
  const gateway = gatewayFromEnv();
  const metadata = { manythreads_workspace: workspaceId, manythreads_bot: botId, plugin: 'gateway-llm' };

  if (existing && live) {
    if (models.length === 0) {
      // Nothing bound for this bot any more (alias unbound, BOT.md edited): a key with no aliases would be a key for all of them.
      await revokeBotKey(ctx, tx, botId);
      return 'revoked';
    }
    const same = existing.models.length === models.length && models.every((m, i) => existing.models[i] === m);
    if (gateway.enabled) {
      // The row says the key is live, but the proxy may have lost it (it was replaced, or its database was wiped): every run would then
      // fail with "Invalid proxy server token". So even an unchanged set is confirmed with the proxy — one call, and a key the proxy
      // does not know (404) is registered again with the SAME value, so the runtime and the proxy agree without rotating anything.
      const reregistered = await gateway.updateKey({ key: await ctx.secrets.get(tx, existing.secret_id as string), aliases: models, metadata });
      if (same) {
        if (!reregistered) return 'unchanged';
        await tx.query('UPDATE app.llm_keys SET models = $2 WHERE bot_id = $1', [botId, models]);
        return 'healed';
      }
    } else if (same) return 'unchanged';
    await tx.query('UPDATE app.llm_keys SET models = $2 WHERE bot_id = $1', [botId, models]);
    await ctx.audit.emit(tx, { type: 'llm.key.changed', workspaceId, botId, action: 'updated', keyPrefix: null });
    return 'updated';
  }
  if (models.length === 0) return 'skipped';

  const key = newBotKey();
  const secretId = await ctx.secrets.put(tx, key);
  await tx.query(
    `INSERT INTO app.llm_keys AS k (bot_id, workspace_id, secret_id, key_prefix, models, created_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, now(), NULL)
     ON CONFLICT (bot_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, secret_id = EXCLUDED.secret_id,
       key_prefix = EXCLUDED.key_prefix, models = EXCLUDED.models, created_at = now(), revoked_at = NULL`,
    [botId, workspaceId, secretId, keyPrefix(key), models],
  );
  // A bare row from before (revoked_at set by an older release, or a race): its secret is now unreferenced, so drop it.
  if (existing?.secret_id && existing.secret_id !== secretId) await ctx.secrets.delete(tx, existing.secret_id);

  if (gateway.enabled) await gateway.mintKey({ key, aliases: models, metadata });
  await ctx.audit.emit(tx, { type: 'llm.key.changed', workspaceId, botId, action: 'minted', keyPrefix: keyPrefix(key) });
  return 'minted';
}

/** The last time a rejected key asked for a re-check, per bot, in this process: a run that fails every few seconds must not become a call to the proxy each time. */
const lastRejection = new Map<string, number>();
const REJECTION_COOLDOWN_MS = 60_000;

/**
 * A run (or the run-scoped proxy) saw the proxy answer 401 to this bot's key. Queue a sync for the bot: it confirms the key at the proxy and
 * registers the same key again if the proxy lost it, so the next run works. Deduplicated while one is waiting, and at most one a minute per bot per process.
 */
export async function requestKeyCheck(ctx: PluginContext, tx: PluginTx, botId: string, now: () => number = Date.now): Promise<boolean> {
  const at = now();
  if (at - (lastRejection.get(botId) ?? -Infinity) < REJECTION_COOLDOWN_MS) return false;
  const bot = (await tx.query<{ workspace_id: string }>(`SELECT workspace_id FROM app.bots WHERE id = $1 AND status = 'active'`, [botId])).rows[0];
  if (!bot) return false;
  lastRejection.set(botId, at);
  await ctx.jobs.enqueue(tx, SYNC_KEY_QUEUE, { workspaceId: bot.workspace_id, botId, action: 'mint' }, { dedupeKey: `recheck:${botId}` });
  return true;
}

/** Test seam: forget the cooldown. */
export const forgetKeyChecks = (): void => lastRejection.clear();

/** Mint the bot's key if it has none and may call something; answers whether it minted (false: it already had one, or has nothing to call yet). */
export async function mintBotKey(ctx: PluginContext, tx: PluginTx, workspaceId: string, botId: string): Promise<boolean> {
  return (await syncBotKey(ctx, tx, workspaceId, botId)) === 'minted';
}

/** Every active bot of a workspace, synced: what a config push, a bound alias or the daily reconcile has to repeat for all of them. */
export async function syncWorkspaceKeys(
  ctx: PluginContext,
  tx: PluginTx,
  workspaceId: string,
  guard?: { failed: number; log: { warn(message: string): void } },
): Promise<Record<KeySyncResult, number>> {
  const tally: Record<KeySyncResult, number> = { minted: 0, updated: 0, healed: 0, unchanged: 0, skipped: 0, revoked: 0 };
  const bots = (
    await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE workspace_id = $1 AND status = 'active' AND runtime = 'hermes'`, [workspaceId])
  ).rows;
  for (const bot of bots) {
    if (!guard) {
      tally[await syncBotKey(ctx, tx, workspaceId, bot.id)] += 1;
      continue;
    }
    // One bot failing (a proxy error, a bad row) must not stop the others: each runs in its own savepoint and the failure is counted.
    await tx.query('SAVEPOINT llm_key_sync');
    try {
      tally[await syncBotKey(ctx, tx, workspaceId, bot.id)] += 1;
      await tx.query('RELEASE SAVEPOINT llm_key_sync');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT llm_key_sync');
      guard.failed += 1;
      guard.log.warn(`gateway-llm: key of bot ${bot.id} could not be synced: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return tally;
}

/** Delete the bot's key: from the proxy, from the secret store and from `llm_keys`. Idempotent (no row is a no-op). */
export async function revokeBotKey(ctx: PluginContext, tx: PluginTx, botId: string): Promise<boolean> {
  // The same per-bot lock a sync takes: without it a sync that read the row live could register the key again at the proxy after this revoke
  // deleted it there, leaving a proxy key with no row. Held to the end of the transaction, so the later of the two sees the earlier one's result.
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('llm-key:' || $1::text))`, [botId]);
  const row = (await tx.query<KeyRow>('SELECT * FROM app.llm_keys WHERE bot_id = $1', [botId])).rows[0];
  if (!row) return false;
  if (row.secret_id) {
    const key = await ctx.secrets.get(tx, row.secret_id);
    const gateway = gatewayFromEnv();
    if (gateway.enabled) await gateway.revokeKey(key);
  }
  // The row goes before the secret: `llm_keys.secret_id` references it, so deleting the secret first would be an FK violation
  // (the sign-in provider route deletes its row first for the same reason).
  await tx.query('DELETE FROM app.llm_keys WHERE bot_id = $1', [botId]);
  if (row.secret_id) await ctx.secrets.delete(tx, row.secret_id);
  await ctx.audit.emit(tx, { type: 'llm.key.changed', workspaceId: row.workspace_id, botId, action: 'revoked', keyPrefix: null });
  return true;
}

const SyncPayload = z.object({ workspaceId: z.uuid(), botId: z.uuid(), action: z.enum(['mint', 'revoke']) });

/** The sync-key job: mint or revoke, as the system actor, scoped to the payload's workspace. */
export function registerSyncKeyJob(ctx: PluginContext): void {
  ctx.jobs.register(SYNC_KEY_QUEUE, async (payload, tx, job) => {
    const input = SyncPayload.parse(payload);
    // The bot may be gone by the time the revoke runs, and a mint for a bot that no longer exists must not resurrect a key.
    const exists = await tx.query<{ one: number }>(`SELECT 1 AS one FROM app.bots WHERE id = $1 AND workspace_id = $2 AND status = 'active'`, [
      input.botId,
      input.workspaceId,
    ]);
    if (input.action === 'mint') {
      if (!exists.rows[0]) return;
      const result = await syncBotKey(ctx, tx, input.workspaceId, input.botId);
      if (result !== 'unchanged') job.log.info(`gateway-llm: key of bot ${input.botId}: ${result}`);
      return;
    }
    if (await revokeBotKey(ctx, tx, input.botId)) job.log.info(`gateway-llm: revoked the key of bot ${input.botId}`);
  });
}

/**
 * The daily reconcile (cron, no payload): every workspace's keys are brought back in line — a live bot without a key gets
 * one, a key without a live bot goes — and the config is re-pushed, so a workspace whose apply-config job dead-lettered
 * catches up. One run covers every workspace, which is why it is a cron job rather than one per workspace.
 */
export function registerReconcileJob(ctx: PluginContext): void {
  ctx.jobs.register(RECONCILE_QUEUE, async (_payload, tx, job) => {
    await reconcileAll(ctx, tx, job.log);
  }, { cron: '23 3 * * *' });
}

/** Every workspace's keys brought in line, orphans revoked, config re-pushed: the body of the daily reconcile and of the boot heal. */
async function reconcileAll(ctx: PluginContext, tx: PluginTx, log: { info(message: string): void; warn(message: string): void }): Promise<number> {
  // Every active hermes bot, synced: a missing key is minted, a key the proxy lost is registered again, a key whose aliases moved is
  // updated, one with nothing left to call is taken away. (Workspace by workspace, because the alias set is a workspace's.)
  const tally: Record<KeySyncResult, number> = { minted: 0, updated: 0, healed: 0, unchanged: 0, skipped: 0, revoked: 0 };
  const guard = { failed: 0, log };
  const workspaces = (await tx.query<{ id: string }>('SELECT id FROM app.workspaces')).rows;
  for (const workspace of workspaces) {
    const part = await syncWorkspaceKeys(ctx, tx, workspace.id, guard);
    for (const name of Object.keys(tally) as KeySyncResult[]) tally[name] += part[name];
  }
  const orphans = (
    await tx.query<{ bot_id: string }>(`SELECT k.bot_id FROM app.llm_keys k WHERE NOT EXISTS (SELECT 1 FROM app.bots b WHERE b.id = k.bot_id)`)
  ).rows;
  for (const orphan of orphans) await revokeBotKey(ctx, tx, orphan.bot_id);
  for (const workspace of workspaces) await ctx.jobs.enqueue(tx, APPLY_CONFIG_QUEUE, { workspaceId: workspace.id });
  log.info(
    `gateway-llm: reconcile minted ${tally.minted}, updated ${tally.updated}, re-registered ${tally.healed}, revoked ${tally.revoked + orphans.length}, re-queued ${workspaces.length} config push(es)${guard.failed > 0 ? `; ${guard.failed} bot(s) failed and were skipped` : ''}`,
  );
  return guard.failed;
}

/** Set once this process has healed the proxy; the plugin host has no start hook for ordinary plugins, so the heal job below checks it. */
let healedThisBoot = false;
/** Test seam: forget that this process healed, as a restart does. */
export const forgetBootHeal = (): void => {
  healedThisBoot = false;
};

/**
 * The boot heal: a replaced or wiped proxy has lost every bot key and model, and waiting for the 03:23 reconcile would leave every run failing
 * until then. The host gives plain plugins no start hook, so this is a cheap cron (every 5 minutes) whose handler does nothing after the
 * first success in a process: the first tick after a start runs the whole reconcile once (one proxy call per bot), the rest return at once.
 */
export function registerBootHealJob(ctx: PluginContext): void {
  ctx.jobs.register(
    BOOT_HEAL_QUEUE,
    async (_payload, tx, job) => {
      if (healedThisBoot) return;
      if (!gatewayFromEnv().enabled) return; // no proxy configured: nothing to heal, and stay armed in case it is configured later
      // Done only when every bot synced; otherwise the next tick tries again.
      if ((await reconcileAll(ctx, tx, job.log)) === 0) healedThisBoot = true;
    },
    { cron: '*/5 * * * *' },
  );
}

/** The bot events: a loaded bot gets a key, a removed bot loses it. Both only enqueue; the job does the work. */
export function registerKeySubscriptions(ctx: PluginContext): void {
  ctx.events.subscribe('bots.bot.loaded', async (raw: PluginEvent, tx: PluginTx) => {
    const event = BotsBotLoadedEvent.parse(raw);
    await ctx.jobs.enqueue(tx, SYNC_KEY_QUEUE, { workspaceId: event.workspaceId, botId: event.botId, action: 'mint' }, { dedupeKey: `mint:${event.botId}:${event.definitionSha}` });
  });
  ctx.events.subscribe('bots.bot.removed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = BotsBotRemovedEvent.parse(raw);
    await ctx.jobs.enqueue(tx, SYNC_KEY_QUEUE, { workspaceId: event.workspaceId, botId: event.botId, action: 'revoke' }, { dedupeKey: `revoke:${event.botId}` });
  });
}
