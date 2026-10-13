import {
  appendMemoryLine,
  HELD_STATE_OUTCOMES_SQL as SDK_HELD_STATE_OUTCOMES_SQL,
  latestMemoryLine,
  type MemoryLogAppend,
  type MemoryLogLine,
} from '@manythreads/sdk';
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
    // A bot's own `memory.retain` line is named by its run, not by the document id the platform derived for the text (a digest of it).
    sourceId: r.source_kind === 'run_tool' ? (r.run_id ?? r.id) : r.source_id,
    documentId: r.source_kind === 'run_tool' ? null : r.document_id,
    outcome: r.outcome,
    reason: r.reason,
    runId: r.run_id,
    sourceScopes: r.source_scopes,
    actorId: r.actor_id,
    link: r.link,
    createdAt: r.created_at.toISOString(),
  });
}

/** What the feed needs of the newest line of a source (the rules of reading the log live in `@manythreads/sdk`, `memory-ledger.ts`: the git mirror reads it too). */
export type LastLine = MemoryLogLine;

/** The two outcomes that say what the bank holds for a source (a SQL list, one constant: `latestLine`, `mark` and the channel sweep all read it). */
export const HELD_STATE_OUTCOMES_SQL = SDK_HELD_STATE_OUTCOMES_SQL;

/**
 * What the log says of a source, for the one question "what is in the bank for it?": the newest of the `retained` / `forgotten` lines is the
 * state (a `withheld` line is information about a refusal, a `not_configured` or `failed` line a note about an attempt); when the state is
 * `forgotten` (or there is none), a `withheld` line newer than it is returned instead, so the same refusal is written once.
 */
export const latestLine = latestMemoryLine;

export type AppendLine = MemoryLogAppend;

/** Appends one line (system transaction). Reasons and links are clipped to what the columns hold; nothing here carries retained text. */
export const appendLine = appendMemoryLine;
