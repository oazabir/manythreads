import type { PluginTx } from '@manythreads/sdk';
import { MemoryRetainLogEntry } from '@manythreads/shared';

/** One `memory_retain_log` row as the driver returns it. */
export interface RetainLogRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  store: string;
  bank: string;
  source_kind: string;
  source_id: string;
  channel_id: string | null;
  document_id: string | null;
  outcome: string;
  reason: string;
  run_id: string | null;
  source_scopes: string[];
  actor_id: string | null;
  link: string;
  created_at: Date;
}

// `content_hash` is a column of the table (it recognises an unchanged re-delivery) and not a field of the API shape: it is never selected here.
export const RETAIN_LOG_COLUMNS =
  'id, workspace_id, team_id, store, bank, source_kind, source_id, channel_id, document_id, outcome, reason, run_id, source_scopes, actor_id, link, created_at';

/** The one place a `memory_retain_log` row becomes the shared `MemoryRetainLogEntry`. */
export function toMemoryRetainLogEntry(r: RetainLogRow): MemoryRetainLogEntry {
  return MemoryRetainLogEntry.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    store: r.store,
    bank: r.bank,
    sourceKind: r.source_kind,
    sourceId: r.source_id,
    documentId: r.document_id,
    outcome: r.outcome,
    reason: r.reason,
    runId: r.run_id,
    sourceScopes: r.source_scopes,
    actorId: r.actor_id,
    link: r.link,
    createdAt: r.created_at.toISOString(),
  });
}

/** What the feed needs of the newest line of a source. */
export interface LastLine extends Record<string, unknown> {
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

/** The outcomes that say what the bank holds for a source; `not_configured` and `failed` are notes about attempts and never change it. */
export const STATE_OUTCOMES = ['retained', 'forgotten', 'withheld'] as const;

/**
 * The newest line of one source that says what the bank holds for it (a `retained` line: the document; `forgotten` / `withheld`: nothing). A
 * `not_configured` line (written while no engine was there) or a `failed` one (the engine would not take, or would not let go of, a document)
 * does not shadow it: a document that is still in the bank is still "held", so a later delete or edit still takes it out.
 */
export async function latestLine(tx: PluginTx, kind: string, sourceId: string): Promise<LastLine | null> {
  const res = await tx.query<LastLine>(
    `SELECT id, team_id, workspace_id, bank, document_id, content_hash, outcome, reason, channel_id, created_at
       FROM app.memory_retain_log
      WHERE source_kind = $1 AND source_id = $2 AND outcome IN ('retained', 'forgotten', 'withheld')
      ORDER BY id DESC LIMIT 1`,
    [kind, sourceId],
  );
  return res.rows[0] ?? null;
}

export interface AppendLine {
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
export async function appendLine(tx: PluginTx, line: AppendLine): Promise<void> {
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
