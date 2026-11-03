import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { InboxHoldReason, InboxOrigin } from '@manythreads/shared';
import { COMMIT_QUEUE, DISTIL_QUEUE, EXTRACT_QUEUE, HOLD_QUEUE, IMPORT_QUEUE } from './receive.ts';
import type { ItemRow } from './rows.ts';
import { lockItem, notifyDropper } from './util.ts';

// The moves an item makes that more than one step needs: held, failed, and "come back later". Each writes the row, the event and the dropper's push in the
// caller's transaction, so what the list shows and what the log says cannot differ.

export const FAILURE_STAGES = { hold: 'extract', extract: 'extract', distil: 'distil', commit: 'commit', import: 'import' } as const;
export type PipelineStage = keyof typeof FAILURE_STAGES;

const cut = (text: string, max = 400): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const QUEUES: Readonly<Record<PipelineStage, string>> = { hold: HOLD_QUEUE, extract: EXTRACT_QUEUE, distil: DISTIL_QUEUE, commit: COMMIT_QUEUE, import: IMPORT_QUEUE };
export const queueOfStage = (stage: string): string | null => (stage in QUEUES ? QUEUES[stage as keyof typeof QUEUES] : null);

/** The next try of a step, `seconds` from now (a job that runs again, not a retry of a failed one). */
export async function enqueueIn(ctx: PluginContext, tx: PluginTx, stage: PipelineStage, row: Pick<ItemRow, 'id' | 'workspace_id'>, seconds: number): Promise<void> {
  await ctx.jobs.enqueue(tx, QUEUES[stage], { workspaceId: row.workspace_id, itemId: row.id }, { runAt: new Date(ctx.runtime.now().getTime() + seconds * 1000) });
}

/** The first run of a step, once: asking twice for the same step of the same item while the first waits returns the first. */
export async function enqueueStep(ctx: PluginContext, tx: PluginTx, stage: PipelineStage, row: Pick<ItemRow, 'id' | 'workspace_id'>): Promise<void> {
  await ctx.jobs.enqueue(tx, QUEUES[stage], { workspaceId: row.workspace_id, itemId: row.id }, { dedupeKey: `${stage}:${row.id}` });
}

/** The item cannot go on until a lead or admin decides: stored, never read by a model, never in memory. */
export async function holdItem(ctx: PluginContext, tx: PluginTx, row: ItemRow, reason: InboxHoldReason, message: string): Promise<void> {
  await tx.query(`UPDATE app.memory_inbox_items SET state = 'held', hold_reason = $2, reason = $3 WHERE id = $1`, [row.id, reason, cut(message)]);
  await ctx.audit.emit(tx, {
    type: 'memory.item.held',
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    itemId: row.id,
    origin: row.origin as InboxOrigin,
    reason,
    droppedBy: row.dropper_id,
    at: ctx.runtime.now().toISOString(),
  });
  await notifyDropper(ctx, tx, row, 'held');
}

/** The item stopped with a reason a person can read. `stage` is the step that failed (Retry starts again there). */
export async function failItem(ctx: PluginContext, tx: PluginTx, row: ItemRow, stage: 'extract' | 'distil' | 'validate' | 'commit' | 'import', message: string): Promise<void> {
  await tx.query(`UPDATE app.memory_inbox_items SET state = 'failed', failed_stage = $2, reason = $3, not_before = NULL, drop_run_id = NULL WHERE id = $1`, [row.id, stage, cut(message)]);
  await ctx.audit.emit(tx, {
    type: 'memory.item.failed',
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    itemId: row.id,
    origin: row.origin as InboxOrigin,
    stage,
    attempts: Math.max(1, row.attempts),
    droppedBy: row.dropper_id,
    at: ctx.runtime.now().toISOString(),
  });
  await notifyDropper(ctx, tx, row, 'failed');
}

export type Claim = { kind: 'go'; row: ItemRow } | { kind: 'wait' } | { kind: 'skip' };

/** Two items of one team at a time (SPEC §12.2): the rest wait this long and look again. */
export const PARALLEL_PER_TEAM = 2;
export const BUSY_RETRY_SECONDS = 10;

/**
 * Takes an item for a step: it must be at that `stage` and waiting (`queued`) or already marked as running (a job that crashed and is run again). A
 * `queued` item moves to `running` only if the team has fewer than two items running and its own wait (`not_before`) is over; otherwise the step is queued
 * again for later and `wait` says so. Takes the item's row lock and the team's lock, in that order, so two claims of one team take turns.
 */
export async function claim(ctx: PluginContext, tx: PluginTx, itemId: string, stage: 'extract' | 'distil' | 'commit' | 'import', running: 'extracting' | 'filing'): Promise<Claim> {
  const row = await lockItem(tx, itemId);
  if (!row || row.stage !== stage || (row.state !== 'queued' && row.state !== running)) return { kind: 'skip' };
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`memory_inbox_run:${row.team_id}`]);
  const gate = (
    await tx.query<{ left_seconds: string | null; busy: string }>(
      `SELECT CASE WHEN i.not_before IS NOT NULL AND i.not_before > now() THEN ceil(extract(epoch FROM i.not_before - now()))::text END AS left_seconds,
              (SELECT count(*) FROM app.memory_inbox_items o WHERE o.team_id = i.team_id AND o.id <> i.id AND o.state IN ('extracting', 'filing'))::text AS busy
         FROM app.memory_inbox_items i WHERE i.id = $1`,
      [itemId],
    )
  ).rows[0];
  if (row.state === 'queued') {
    if (gate?.left_seconds) {
      await enqueueIn(ctx, tx, stage, row, Math.max(1, Number(gate.left_seconds)));
      return { kind: 'wait' };
    }
    if (Number(gate?.busy ?? 0) >= PARALLEL_PER_TEAM) {
      await enqueueIn(ctx, tx, stage, row, BUSY_RETRY_SECONDS);
      return { kind: 'wait' };
    }
  }
  const moved = (
    await tx.query<ItemRow>(
      `UPDATE app.memory_inbox_items i
          SET state = $2, attempts = i.attempts + CASE WHEN i.state = 'queued' THEN 1 ELSE 0 END, not_before = NULL, reason = NULL
        WHERE i.id = $1 RETURNING i.*`,
      [itemId, running],
    )
  ).rows[0] as ItemRow;
  return { kind: 'go', row: moved };
}
