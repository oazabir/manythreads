import { randomBytes } from 'node:crypto';
import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { BotsBotLoadedEvent, BotsBotRemovedEvent } from '@manythreads/shared';
import { z } from 'zod';
import { APPLY_CONFIG_QUEUE, RECONCILE_QUEUE, SYNC_KEY_QUEUE, gatewayFromEnv } from './gateway.ts';
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
 * Mint the bot's key once: idempotent, so an event replay or a reconcile finds the live key and changes nothing. Answers
 * whether it minted (false when a live key was already there). The proxy call happens before the row's insert commits, so a
 * failure rolls back the secret too and the job retries; the key is caller-chosen, so a retry is harmless.
 */
export async function mintBotKey(ctx: PluginContext, tx: PluginTx, workspaceId: string, botId: string): Promise<boolean> {
  const existing = (await tx.query<{ secret_id: string | null; revoked_at: Date | null }>('SELECT secret_id, revoked_at FROM app.llm_keys WHERE bot_id = $1', [botId]))
    .rows[0];
  if (existing && existing.revoked_at === null) return false;

  const key = newBotKey();
  const secretId = await ctx.secrets.put(tx, key);
  await tx.query(
    `INSERT INTO app.llm_keys AS k (bot_id, workspace_id, secret_id, key_prefix, created_at, revoked_at)
     VALUES ($1, $2, $3, $4, now(), NULL)
     ON CONFLICT (bot_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, secret_id = EXCLUDED.secret_id,
       key_prefix = EXCLUDED.key_prefix, created_at = now(), revoked_at = NULL`,
    [botId, workspaceId, secretId, keyPrefix(key)],
  );
  // A bare row from before (revoked_at set by an older release, or a race): its secret is now unreferenced, so drop it.
  if (existing?.secret_id && existing.secret_id !== secretId) await ctx.secrets.delete(tx, existing.secret_id);

  // The aliases the bot may ask for: its runtime names aliases, never models, and the proxy refuses an unlisted one.
  const aliases = (await tx.query<{ alias: string }>('SELECT alias FROM app.llm_aliases WHERE workspace_id = $1', [workspaceId])).rows.map(
    (r) => r.alias,
  );
  const gateway = gatewayFromEnv();
  if (gateway.enabled) {
    await gateway.mintKey({ key, aliases, metadata: { workspace_id: workspaceId, bot_id: botId, plugin: 'gateway-llm' } });
  }
  ctx.audit.emit(tx, { type: 'llm.key.changed', workspaceId, botId, action: 'minted', keyPrefix: keyPrefix(key) });
  return true;
}

/** Delete the bot's key: from the proxy, from the secret store and from `llm_keys`. Idempotent (no row is a no-op). */
export async function revokeBotKey(ctx: PluginContext, tx: PluginTx, botId: string): Promise<boolean> {
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
  ctx.audit.emit(tx, { type: 'llm.key.changed', workspaceId: row.workspace_id, botId, action: 'revoked', keyPrefix: null });
  return true;
}

const SyncPayload = z.object({ workspaceId: z.uuid(), botId: z.uuid(), action: z.enum(['mint', 'revoke']) });

/** The sync-key job: mint or revoke, as the system actor, scoped to the payload's workspace. */
export function registerSyncKeyJob(ctx: PluginContext): void {
  ctx.jobs.register(SYNC_KEY_QUEUE, async (payload, tx, job) => {
    const input = SyncPayload.parse(payload);
    // The bot may be gone by the time the revoke runs, and a mint for a bot that no longer exists must not resurrect a key.
    const exists = await tx.query<{ one: number }>('SELECT 1 AS one FROM app.bots WHERE id = $1 AND workspace_id = $2', [
      input.botId,
      input.workspaceId,
    ]);
    if (input.action === 'mint') {
      if (!exists.rows[0]) return;
      if (await mintBotKey(ctx, tx, input.workspaceId, input.botId)) job.log.info(`gateway-llm: minted a key for bot ${input.botId}`);
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
  ctx.jobs.register(
    RECONCILE_QUEUE,
    async (_payload, tx, job) => {
      const missing = (
        await tx.query<{ workspace_id: string; bot_id: string }>(
          `SELECT b.workspace_id, b.id AS bot_id FROM app.bots b
            WHERE b.status = 'active' AND b.runtime = 'hermes'
              AND NOT EXISTS (SELECT 1 FROM app.llm_keys k WHERE k.bot_id = b.id AND k.revoked_at IS NULL)`,
        )
      ).rows;
      for (const bot of missing) await mintBotKey(ctx, tx, bot.workspace_id, bot.bot_id);

      const orphans = (
        await tx.query<{ bot_id: string }>(
          `SELECT k.bot_id FROM app.llm_keys k WHERE NOT EXISTS (SELECT 1 FROM app.bots b WHERE b.id = k.bot_id)`,
        )
      ).rows;
      for (const orphan of orphans) await revokeBotKey(ctx, tx, orphan.bot_id);

      const workspaces = (await tx.query<{ id: string }>('SELECT id FROM app.workspaces')).rows;
      for (const workspace of workspaces) await ctx.jobs.enqueue(tx, APPLY_CONFIG_QUEUE, { workspaceId: workspace.id });
      job.log.info(`gateway-llm: reconcile minted ${missing.length}, revoked ${orphans.length}, re-queued ${workspaces.length} config push(es)`);
    },
    { cron: '23 3 * * *' },
  );
}

/** The bot events: a loaded bot gets a key, a removed bot loses it. Both only enqueue; the job does the work. */
export function registerKeySubscriptions(ctx: PluginContext): void {
  ctx.events.subscribe('bots.bot.loaded', async (raw: PluginEvent, tx: PluginTx) => {
    const event = BotsBotLoadedEvent.parse(raw);
    await ctx.jobs.enqueue(tx, SYNC_KEY_QUEUE, { workspaceId: event.workspaceId, botId: event.botId, action: 'mint' }, { dedupeKey: `mint:${event.botId}` });
  });
  ctx.events.subscribe('bots.bot.removed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = BotsBotRemovedEvent.parse(raw);
    await ctx.jobs.enqueue(tx, SYNC_KEY_QUEUE, { workspaceId: event.workspaceId, botId: event.botId, action: 'revoke' }, { dedupeKey: `revoke:${event.botId}` });
  });
}
