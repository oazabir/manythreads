import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { McpToolsStatus } from '@manythreads/shared';
import { toolsDigest } from './digest.ts';
import { listingHandleOf, offeredTools, type PairedBotHandle } from './protocol.ts';

// What the database keeps about a bot's tool list (`app.mcp_bot_tools`, migration 0002): the digest of what `tools/list` answers it now, a counter
// that goes up when that digest changes, and the digest its token last read. Everything here runs as the system role.

interface BotRow {
  [key: string]: unknown;
  bot_id: string;
  actor_id: string;
  team_id: string;
  workspace_id: string;
}

/** The bot as `tools/list` judges it, or null for a bot that is gone. */
export async function botHandleOf(tx: PluginTx, botId: string): Promise<PairedBotHandle | null> {
  const row = (
    await tx.query<BotRow>(
      `SELECT b.id AS bot_id, a.id AS actor_id, b.team_id, b.workspace_id
         FROM app.bots b
         JOIN app.actors a ON a.kind = 'bot' AND a.workspace_id = b.workspace_id AND a.ref_id = b.id
        WHERE b.id = $1::uuid`,
      [botId],
    )
  ).rows[0];
  return row ? { botId: row.bot_id, botActorId: row.actor_id, teamId: row.team_id, workspaceId: row.workspace_id } : null;
}

/** The digest of what `tools/list` answers the bot right now (the list it gets with no run open), or null for a bot that is gone. */
export async function currentToolsDigest(ctx: PluginContext, tx: PluginTx, botId: string): Promise<string | null> {
  const bot = await botHandleOf(tx, botId);
  return bot ? toolsDigest(await offeredTools(ctx, listingHandleOf(bot))) : null;
}

/** Holds the bot's tools lock until the transaction ends. */
export async function lockTools(tx: PluginTx, botId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gateway-mcp/tools/${botId}`]);
}

/**
 * Re-reads the bot's list and keeps the answer: when the digest differs from the one stored (or none is), the counter goes up, and every open stream
 * of the bot, on any replica, sends `list_changed` on its next look. Answers the digest, the counter and whether it moved.
 */
export async function refreshPushedDigest(ctx: PluginContext, tx: PluginTx, botId: string): Promise<{ digest: string; version: string; changed: boolean } | null> {
  // One refresh of a bot at a time, and the list is read AFTER the lock is held: a refresh that waited sees what the one before it committed, so an
  // older digest can never be written over a newer one.
  await lockTools(tx, botId);
  const digest = await currentToolsDigest(ctx, tx, botId);
  if (digest === null) return null;
  const moved = await tx.query(
    `INSERT INTO app.mcp_bot_tools AS t (bot_id, pushed_digest) VALUES ($1::uuid, $2)
     ON CONFLICT (bot_id) DO UPDATE SET pushed_digest = EXCLUDED.pushed_digest, version = t.version + 1, pushed_at = now()
       WHERE t.pushed_digest <> EXCLUDED.pushed_digest
     RETURNING version::text AS version`,
    [botId, digest],
  );
  if (moved.rows[0]) return { digest, version: String(moved.rows[0]['version']), changed: true };
  const same = await tx.query<{ version: string }>('SELECT version::text AS version FROM app.mcp_bot_tools WHERE bot_id = $1::uuid', [botId]);
  return { digest, version: same.rows[0]?.version ?? '0', changed: false };
}

/** The change counter of each bot that has a row. */
export async function readVersions(tx: PluginTx, botIds: readonly string[]): Promise<Map<string, string>> {
  const res = await tx.query<{ bot_id: string; version: string }>('SELECT bot_id, version::text AS version FROM app.mcp_bot_tools WHERE bot_id = ANY($1::uuid[])', [botIds]);
  return new Map(res.rows.map((r) => [r.bot_id, r.version]));
}

/** Of these token hashes (hex), the ones that still resolve to a bot: one statement however many streams are open. */
export async function stillValidTokens(tx: PluginTx, hashes: readonly string[]): Promise<Set<string>> {
  const res = await tx.query<{ h: string }>(
    `SELECT encode(h.hash, 'hex') AS h
       FROM unnest($1::bytea[]) AS h(hash)
       JOIN LATERAL app.bots_pairing_resolve(h.hash) r ON true`,
    [hashes.map((h) => Buffer.from(h, 'hex'))],
  );
  return new Set(res.rows.map((r) => r.h));
}

/** The bot's token has read its tools: keep which list, and when. */
export async function recordListing(tx: PluginTx, botId: string, digest: string): Promise<void> {
  await tx.query(
    `INSERT INTO app.mcp_bot_tools (bot_id, pushed_digest, listed_digest, listed_at) VALUES ($1::uuid, $2, $2, now())
     ON CONFLICT (bot_id) DO UPDATE SET listed_digest = EXCLUDED.listed_digest, listed_at = now()`,
    [botId, digest],
  );
}

/** Whether the bot's Hermes holds the tools it would be offered now; the bot page says it in a line. */
export async function toolsStatusOf(ctx: PluginContext, tx: PluginTx, botId: string): Promise<McpToolsStatus | null> {
  const digest = await currentToolsDigest(ctx, tx, botId);
  if (digest === null) return null;
  const row = (
    await tx.query<{ listed_digest: string | null; listed_at: string | Date | null }>('SELECT listed_digest, listed_at FROM app.mcp_bot_tools WHERE bot_id = $1::uuid', [botId])
  ).rows[0];
  const listedDigest = row?.listed_digest ?? null;
  return {
    state: listedDigest === null ? 'never' : listedDigest === digest ? 'current' : 'older',
    digest,
    listedDigest,
    listedAt: row?.listed_at ? new Date(row.listed_at).toISOString() : null,
  };
}
