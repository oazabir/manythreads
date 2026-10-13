import { createHmac, randomBytes } from 'node:crypto';
import type { PluginTx } from './types.ts';

// The memory ledger as the plugins that feed a team's bank see it (PLAN P5-13 `memory`, P5-14 `memory-git-mirror`): the one table they both write
// (`app.memory_retain_log`, migration of the `memory` plugin), the one key their documents are named by (`app.memory_workspace_keys`), and the
// rules for reading "what does the bank hold for this source". Two plugins write one append-only log; the rules of reading it live here once, so
// they cannot drift. System transactions only: neither table has a privilege for the request role.
//
// The rules (each one was a review finding of P5-13; docs/plugins/memory.md):
//
//  * What the bank holds for a source is the newest of its `retained` / `forgotten` lines. A `withheld` line is a note about a refusal and never
//    makes a document "not held"; a `not_configured` or `failed` line is a note about an attempt and counts for nothing.
//  * The keyed digest of a text is an HMAC under a per-workspace random key: an unkeyed hash of a message would be a dictionary oracle for whoever
//    reads the log or a document id (a `forgotten` line is a deleted, perhaps secret, text).
//  * The key is made by the handler that marks a source, in the transaction that commits the work row, and only READ by a drain: a key created
//    inside a drain that then rolled back would leave documents in the engine named by a key no database has.

/** The two outcomes that say what the bank holds for a source (a SQL list, one constant: every reader of the log uses it). */
export const HELD_STATE_OUTCOMES_SQL = "('retained', 'forgotten')";

/** At most one `not_configured` line per team in this period (a feed would otherwise write one per message). */
export const MEMORY_NOT_CONFIGURED_EVERY_MS = 24 * 60 * 60 * 1000;

/** What a feed needs of the newest line of a source. */
export interface MemoryLogLine extends Record<string, unknown> {
  id: string;
  team_id: string;
  workspace_id: string;
  bank: string;
  document_id: string | null;
  content_hash: string | null;
  outcome: string;
  reason: string;
  channel_id: string | null;
  created_at: Date;
}

/**
 * What the log says of a source, for the one question "what is in the bank for it?": the newest `retained` / `forgotten` line is the state, and
 * a `withheld` line newer than a `forgotten` state (or than no state) is returned instead, so the same refusal is written once.
 */
export async function latestMemoryLine(tx: PluginTx, kind: string, sourceId: string): Promise<MemoryLogLine | null> {
  const columns = 'id, team_id, workspace_id, bank, document_id, content_hash, outcome, reason, channel_id, created_at';
  const state = (
    await tx.query<MemoryLogLine>(
      `SELECT ${columns} FROM app.memory_retain_log
        WHERE source_kind = $1 AND source_id = $2 AND outcome IN ${HELD_STATE_OUTCOMES_SQL} ORDER BY id DESC LIMIT 1`,
      [kind, sourceId],
    )
  ).rows[0];
  if (state?.outcome === 'retained') return state;
  const withheld = (
    await tx.query<MemoryLogLine>(
      `SELECT ${columns} FROM app.memory_retain_log
        WHERE source_kind = $1 AND source_id = $2 AND outcome = 'withheld' AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id DESC LIMIT 1`,
      [kind, sourceId, state?.id ?? null],
    )
  ).rows[0];
  return withheld ?? state ?? null;
}

export interface MemoryLogAppend {
  workspaceId: string;
  teamId: string;
  bank: string;
  sourceKind: string;
  sourceId: string;
  channelId?: string | null;
  documentId?: string | null;
  contentHash?: string | null;
  outcome: 'retained' | 'forgotten' | 'withheld' | 'not_configured' | 'failed';
  reason?: string;
  runId?: string | null;
  scopes?: readonly string[];
  actorId?: string | null;
  link?: string;
}

/** Appends one line (system transaction). Reasons and links are clipped to what the columns hold; nothing here carries retained text. */
export async function appendMemoryLine(tx: PluginTx, line: MemoryLogAppend): Promise<void> {
  await tx.query(
    `INSERT INTO app.memory_retain_log
       (workspace_id, team_id, store, bank, source_kind, source_id, channel_id, document_id, content_hash, outcome, reason, run_id, source_scopes, actor_id, link)
     VALUES ($1::uuid, $2::uuid, 'team_bank', $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11::uuid, $12::text[], $13::uuid, $14)`,
    [
      line.workspaceId,
      line.teamId,
      line.bank.slice(0, 200),
      line.sourceKind,
      line.sourceId.slice(0, 1100),
      line.channelId ?? null,
      line.documentId ?? null,
      line.contentHash ?? null,
      line.outcome,
      (line.reason ?? '').slice(0, 200),
      line.runId ?? null,
      [...(line.scopes ?? [])],
      line.actorId ?? null,
      (line.link ?? '').slice(0, 1500),
    ],
  );
}

/** Makes the workspace's digest key if there is none (idempotent: a second call, or a racing one, changes nothing). Call it where a work row is marked. */
export async function ensureMemoryWorkspaceKey(tx: PluginTx, workspaceId: string): Promise<void> {
  await tx.query(
    'INSERT INTO app.memory_workspace_keys (workspace_id, key) VALUES ($1::uuid, $2) ON CONFLICT (workspace_id) DO NOTHING',
    [workspaceId, randomBytes(32)],
  );
}

/** The workspace's key, or null when none was made. `cache` is the caller's, for the length of one drain (never kept longer). */
export async function readMemoryWorkspaceKey(tx: PluginTx, workspaceId: string, cache: Map<string, Buffer> = new Map()): Promise<Buffer | null> {
  const hit = cache.get(workspaceId);
  if (hit) return hit;
  const key = (await tx.query<{ key: Buffer }>('SELECT key FROM app.memory_workspace_keys WHERE workspace_id = $1::uuid', [workspaceId])).rows[0]?.key ?? null;
  if (key !== null) cache.set(workspaceId, key);
  return key;
}

/** HMAC-SHA-256 of the text under the workspace's key, lowercase hex: what the log keeps instead of the text and what a document id carries. */
export const memoryContentDigest = (text: string, key: Buffer | string): string => createHmac('sha256', key).update(text, 'utf8').digest('hex');

/**
 * The deployment has no memory engine: one `not_configured` line per team per day says so (bank `(no engine)`), and the answer is which of the
 * given sources the bank nevertheless holds a document for (the newest retained / forgotten line says retained) — a delete or an edit made
 * while the engine is off must still take that document out when it is back, so only those are queued; every other change is dropped (no
 * backfill). Events of one batch are handled at the same time: the advisory lock makes the second see the first's line.
 */
export async function noteMemoryNotConfigured(
  tx: PluginTx,
  input: { workspaceId: string; teamId: string; kinds: readonly string[]; ids: readonly string[] },
  everyMs: number = MEMORY_NOT_CONFIGURED_EVERY_MS,
): Promise<Array<{ kind: string; id: string }>> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`memory.not_configured:${input.teamId}`]);
  await tx.query(
    `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason)
     SELECT $1::uuid, $2::uuid, '(no engine)', $3, $4, 'not_configured', 'no memory engine is configured in this deployment'
      WHERE NOT EXISTS (
        SELECT 1 FROM app.memory_retain_log
         WHERE team_id = $2::uuid AND outcome = 'not_configured' AND created_at > now() - $5::float8 * interval '1 millisecond')`,
    [input.workspaceId, input.teamId, input.kinds[0], input.ids[0], everyMs],
  );
  const held = await tx.query<{ kind: string; id: string }>(
    `SELECT s.kind, s.id FROM unnest($1::text[], $2::text[]) AS s(kind, id)
      WHERE (SELECT l.outcome FROM app.memory_retain_log l
              WHERE l.source_kind = s.kind AND l.source_id = s.id AND l.outcome IN ${HELD_STATE_OUTCOMES_SQL}
              ORDER BY l.id DESC LIMIT 1) = 'retained'`,
    [[...input.kinds], [...input.ids]],
  );
  return held.rows;
}
