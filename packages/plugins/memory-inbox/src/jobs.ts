import type { BlobStorage, JobInfo, PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { commitStep, removedNote } from './commit.ts';
import { loadInboxConfig } from './config.ts';
import { distilStep, extractStep, holdStep } from './pipeline.ts';
import { COMMIT_QUEUE, DISTIL_QUEUE, EXTRACT_QUEUE, HOLD_QUEUE, KEEP_QUEUE, SWEEP_QUEUE } from './receive.ts';
import type { ItemRow } from './rows.ts';
import { enqueueStep, failItem, FAILURE_STAGES, type PipelineStage } from './states.ts';
import { attempt, payloadOf } from './util.ts';

// The pipeline's queues (SPEC §12.2: "every step is a job on the Postgres queue"). The handlers check their payload, the item's stage and its state before doing
// anything, so a job that runs twice does nothing the second time. Two cron jobs keep the pipeline moving without anyone watching: the sweep picks up items whose
// job was lost or whose wait is over, and the keeper removes originals a team asked not to keep for ever.

/** An item running for this long has lost its job (a crash, a restart): it goes back in the queue. */
export const STUCK_MINUTES = 30;
/** After this many tries a step is given up on; Retry starts it again by hand. */
export const MAX_TRIES = 5;
const SWEEP_BATCH = 100;
const KEEP_TEAMS_PER_RUN = 500;
const KEEP_ITEMS_PER_TEAM = 100;

export function registerJobs(ctx: PluginContext): void {
  ctx.jobs.register(
    HOLD_QUEUE,
    async (payload, tx) => {
      const p = payloadOf(payload);
      if (p) await holdStep(ctx, tx, p.itemId);
    },
    { concurrency: 4, serialKey: 'itemId' },
  );
  ctx.jobs.register(
    EXTRACT_QUEUE,
    async (payload, _tx, job) => {
      const p = payloadOf(payload);
      if (p) await extractStep(ctx, job, p.itemId);
    },
    { concurrency: 2, serialKey: 'itemId', detached: true },
  );
  ctx.jobs.register(
    DISTIL_QUEUE,
    async (payload, _tx, job) => {
      const p = payloadOf(payload);
      if (p) await distilStep(ctx, job, p.itemId);
    },
    { concurrency: 2, serialKey: 'itemId', detached: true },
  );
  ctx.jobs.register(
    COMMIT_QUEUE,
    async (payload, tx) => {
      const p = payloadOf(payload);
      if (p) await commitStep(ctx, tx, p.itemId);
    },
    { concurrency: 2, serialKey: 'itemId' },
  );
  ctx.jobs.register(
    SWEEP_QUEUE,
    async (_payload, tx) => {
      await sweep(ctx, tx);
    },
    { cron: '* * * * *' },
  );
  ctx.jobs.register(
    KEEP_QUEUE,
    async (_payload, _tx, job) => {
      await keepOriginals(ctx, job);
    },
    { cron: '23 3 * * *', detached: true },
  );
}

/** One pass of the sweep; exported for the tests. Returns how many items it moved. */
export async function sweep(ctx: PluginContext, tx: PluginTx): Promise<number> {
  let moved = 0;
  const stuck = (
    await tx.query<ItemRow>(
      `SELECT i.* FROM app.memory_inbox_items i
        WHERE i.state IN ('extracting', 'filing') AND i.updated_at < now() - make_interval(mins => $1)
        ORDER BY i.updated_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [STUCK_MINUTES, SWEEP_BATCH],
    )
  ).rows;
  for (const row of stuck) {
    moved += 1;
    if (row.attempts >= MAX_TRIES) {
      await failItem(ctx, tx, row, FAILURE_STAGES[row.stage as PipelineStage] ?? 'extract', 'This took too many tries and was stopped. Retry puts it back in the queue.');
    } else {
      await tx.query(`UPDATE app.memory_inbox_items SET state = 'queued' WHERE id = $1`, [row.id]);
    }
  }
  const due = (
    await tx.query<ItemRow>(
      `SELECT i.* FROM app.memory_inbox_items i
        WHERE i.state = 'queued' AND i.stage IN ('hold', 'extract', 'distil', 'commit') AND (i.not_before IS NULL OR i.not_before <= now())
          AND i.updated_at < now() - interval '2 minutes'
        ORDER BY i.updated_at LIMIT $1`,
      [SWEEP_BATCH],
    )
  ).rows;
  for (const row of due) {
    moved += 1;
    await enqueueStep(ctx, tx, row.stage as 'hold' | 'extract' | 'distil' | 'commit', row);
  }
  return moved;
}

interface TeamRef extends Record<string, unknown> {
  team_id: string;
  workspace_id: string;
}

/** One pass of the keeper; exported for the tests. Returns how many originals it removed. */
export async function keepOriginals(ctx: PluginContext, job: Pick<JobInfo, 'transaction'>): Promise<number> {
  const teams = await job.transaction(
    async (tx) =>
      (
        await tx.query<TeamRef>(
          `SELECT team_id, workspace_id FROM app.memory_inbox_items WHERE state = 'filed' AND blob_key IS NOT NULL GROUP BY team_id, workspace_id ORDER BY min(filed_at) LIMIT $1`,
          [KEEP_TEAMS_PER_RUN],
        )
      ).rows,
  );
  const storage = ctx.providers.get<BlobStorage>('storage');
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!storage || !repo) return 0;
  let removed = 0;
  for (const team of teams) {
    const keys = await job.transaction(async (tx) => {
      const config = await loadInboxConfig(ctx, tx, team.team_id);
      if (config.keepOriginals === 'forever') return [];
      const old = (
        await tx.query<ItemRow>(
          `SELECT i.* FROM app.memory_inbox_items i
            WHERE i.team_id = $1 AND i.state = 'filed' AND i.blob_key IS NOT NULL AND i.filed_at < now() - make_interval(days => $2)
            ORDER BY i.filed_at LIMIT $3 FOR UPDATE`,
          [team.team_id, config.keepOriginals, KEEP_ITEMS_PER_TEAM],
        )
      ).rows;
      const gone: string[] = [];
      const on = ctx.runtime.now().toISOString().slice(0, 10);
      for (const row of old) {
        const reference = row.filed_paths[0];
        if (reference !== undefined) {
          await attempt(tx, () => repo.write(tx, row.team_id, { id: tx.actor.id, kind: 'system' }, [{ path: reference, op: 'append', content: removedNote(on) }], `Inbox: original of ${row.name} removed`.slice(0, 120)));
          // If the Reference is gone or refuses the note, the original is still removed (the team asked for that): the note is the only thing lost.
        }
        await tx.query(`UPDATE app.memory_inbox_items SET blob_key = NULL, original_removed_at = now() WHERE id = $1`, [row.id]);
        if (row.blob_key) gone.push(row.blob_key);
      }
      return gone;
    });
    for (const key of keys) {
      // After the commit, so a row never points at a blob that is gone. A blob that cannot be deleted now is left for the blob GC, which finds it unreferenced.
      await storage.delete(key).catch(() => false);
      removed += 1;
    }
  }
  return removed;
}
