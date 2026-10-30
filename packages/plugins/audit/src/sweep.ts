import type { PluginTx } from '@manythreads/sdk';
import { upcast } from '@manythreads/shared';
import { draftOfEvent, draftOfMemoryLine, writeDrafts, type Draft, type MemoryLogLine } from './project.ts';
import { AUDITED_EVENT_TYPES } from './spec.ts';

// The background half of the console: it fills in what the live subscriber cannot.
//  - the memory plugin's own log of what it held back (`memory_retain_log` lines with outcome `withheld`) is not an event, so it is read here;
//  - history from before this plugin existed is projected once, oldest first, in small steps.
// Both are safe to repeat: a row is written once per source id.

export const SWEEP_QUEUE = 'audit.sweep';
const BATCH = 500;
/** A memory log line is read only once it is this old, so a transaction that wrote one and has not committed yet cannot be skipped over. */
const MEMORY_LAG = '2 minutes';
/** How many batches of history one tick may project, so a big history never holds the job for long. */
const BACKFILL_BATCHES_PER_TICK = 10;

const MEMORY_MARK = 'memory_log_position';
const BACKFILL_UNTIL = 'events_backfill_until';
const BACKFILL_AFTER = 'events_backfill_after';
const NIL = '00000000-0000-0000-0000-000000000000';

async function getMark(tx: PluginTx, name: string): Promise<string | null> {
  return (await tx.query<{ value: string }>('SELECT value FROM app.audit_progress WHERE name = $1', [name])).rows[0]?.value ?? null;
}
async function setMark(tx: PluginTx, name: string, value: string): Promise<void> {
  await tx.query(
    `INSERT INTO app.audit_progress (name, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [name, value],
  );
}

/** Projects the memory log's `withheld` lines that are older than the lag and newer than the last position. Returns the rows added. */
export async function sweepMemoryLog(tx: PluginTx, lag: string = MEMORY_LAG): Promise<number> {
  const mark = (await getMark(tx, MEMORY_MARK)) ?? '1970-01-01T00:00:00.000Z|' + NIL;
  const [at = '1970-01-01T00:00:00.000Z', id = NIL] = mark.split('|');
  // The position keeps the line's time as the database wrote it (microseconds): a JavaScript Date holds milliseconds, so a position saved from one
  // would sit before its own line and read it again on every tick.
  const lines = (
    await tx.query<MemoryLogLine & { created_text: string }>(
      `SELECT id, workspace_id, team_id, source_kind, source_id, reason, actor_id, created_at, created_at::text AS created_text
         FROM app.memory_retain_log
        WHERE outcome = 'withheld' AND (created_at, id) > ($1::timestamptz, $2::uuid) AND created_at < now() - $3::interval
        ORDER BY created_at, id LIMIT ${BATCH}`,
      [at, id, lag],
    )
  ).rows;
  if (lines.length === 0) return 0;
  const added = await writeDrafts(tx, lines.map(draftOfMemoryLine));
  const last = lines[lines.length - 1]!;
  await setMark(tx, MEMORY_MARK, `${last.created_text}|${last.id}`);
  return added;
}

type EventRow = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  actor_id: string;
  type: string;
  schema_version: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
};

/** Turns stored event rows into drafts. A row that no longer parses (an old shape) is skipped, never fatal. */
export function draftsOfRows(rows: readonly EventRow[]): Draft[] {
  const out: Draft[] = [];
  for (const row of rows) {
    let event: { type: string; [k: string]: unknown };
    try {
      event = upcast({ ...row.payload, type: row.type, schemaVersion: row.schema_version, workspaceId: row.workspace_id }) as unknown as typeof event;
    } catch {
      continue;
    }
    const draft = draftOfEvent(event, { eventId: row.id, occurredAt: row.occurred_at, actorId: row.actor_id, teamId: row.team_id }, row.workspace_id);
    if (draft) out.push(draft);
  }
  return out;
}

/**
 * Projects the history that was written before the live subscriber existed: events up to the newest one at the first tick, oldest first, one step
 * of `BATCH` at a time. Returns the rows added in this call.
 */
export async function backfillEvents(tx: PluginTx, batches: number = BACKFILL_BATCHES_PER_TICK): Promise<number> {
  let until = await getMark(tx, BACKFILL_UNTIL);
  if (until === null) {
    until = (await tx.query<{ id: string }>('SELECT id::text AS id FROM app.events ORDER BY id DESC LIMIT 1')).rows[0]?.id ?? NIL;
    await setMark(tx, BACKFILL_UNTIL, until);
    await setMark(tx, BACKFILL_AFTER, NIL);
  }
  let after = (await getMark(tx, BACKFILL_AFTER)) ?? NIL;
  let added = 0;
  for (let i = 0; i < batches; i += 1) {
    const rows = (
      await tx.query<EventRow>(
        `SELECT id, workspace_id, team_id, actor_id, type, schema_version, payload, occurred_at
           FROM app.events WHERE type = ANY($1::text[]) AND id > $2::uuid AND id <= $3::uuid ORDER BY id LIMIT ${BATCH}`,
        [AUDITED_EVENT_TYPES, after, until],
      )
    ).rows;
    if (rows.length === 0) {
      after = until;
      await setMark(tx, BACKFILL_AFTER, after);
      break;
    }
    added += await writeDrafts(tx, draftsOfRows(rows));
    after = rows[rows.length - 1]!.id;
    await setMark(tx, BACKFILL_AFTER, after);
    if (rows.length < BATCH) {
      after = until;
      await setMark(tx, BACKFILL_AFTER, after);
      break;
    }
  }
  return added;
}
