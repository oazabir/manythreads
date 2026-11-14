import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { RunEndedPush, WS_RUN_ENDED } from '@manythreads/shared';

// The backstop of the run record (P25-06, review H1). The run job's recorder closes a run's folded row (`run_view`) when its job ends, and a recorder that could not (the
// database was away, the process died) leaves a card that says "working" for a run that is over. This closes such rows from the truth, the run's own row in `bot_runs`:
//
//   * at once, when the kernel announces `bots.run.closed` (whoever closed the run: the job, the reaper, an approval that stopped it);
//   * every couple of minutes, for any row whose `bot_runs` row is no longer running (an event that was missed), and for the leases nobody renewed any more.
//
// A row is closed as `stopped` if somebody asked for the stop, else as the run itself ended (`done`, `stopped`; anything else `failed`). Closing is one statement that only
// touches an open row, so it never overwrites what the recorder wrote (the recorder's own end is the more exact: it knows done from failed even when `bot_runs` says only
// "closed"), and it runs again harmlessly. Each closed row tells the channel's readers that the run ended, like the recorder does.

export const SWEEP_QUEUE = 'runtime-hermes.run-view-sweep';
const SWEEP_BATCH = 100;

type Closed = {
  run_id: string;
  workspace_id: string;
  channel_id: string;
  thread_root_id: string | null;
  conversation: boolean;
  asker_id: string | null;
  state: 'done' | 'failed' | 'stopped';
};

/**
 * Closes the open `run_view` rows whose run is over (all of them, or one run's), and says so to the readers of the channel. Answers how many rows it closed. The transaction is
 * the caller's (an event consumer's, or a sweep's one per workspace) and must be the system's, scoped to the rows' workspace for the audience of the push.
 */
export async function closeOverRuns(ctx: PluginContext, tx: PluginTx, only?: { runId?: string; workspaceId?: string; limit?: number }): Promise<number> {
  const closed = await tx.query<Closed>(
    `WITH over AS (
       SELECT v.run_id, r.status AS run_status, (v.stop_requested_at IS NOT NULL) AS asked
         FROM app.run_view v JOIN app.bot_runs r ON r.id = v.run_id
        WHERE v.ended_at IS NULL AND r.status <> 'running'
          AND ($1::uuid IS NULL OR v.run_id = $1::uuid) AND ($2::uuid IS NULL OR v.workspace_id = $2::uuid)
        ORDER BY v.updated_at
        LIMIT $3
        FOR UPDATE OF v SKIP LOCKED)
     UPDATE app.run_view v
        SET state = CASE WHEN o.asked OR o.run_status = 'stopped' THEN 'stopped' WHEN o.run_status = 'done' THEN 'done' ELSE 'failed' END,
            ended_at = greatest(v.started_at, now()), now_step = NULL, updated_at = now(),
            stopped_by_actor = CASE WHEN o.asked OR o.run_status = 'stopped' THEN v.stopped_by_actor END,
            stopped_by_name = CASE WHEN o.asked OR o.run_status = 'stopped' THEN v.stopped_by_name END
       FROM over o
      WHERE v.run_id = o.run_id AND v.ended_at IS NULL
      RETURNING v.run_id, v.workspace_id, v.channel_id, v.thread_root_id, v.conversation, v.asker_id, v.state`,
    [only?.runId ?? null, only?.workspaceId ?? null, only?.limit ?? SWEEP_BATCH],
  );
  for (const row of closed.rows) await announce(ctx, tx, row);
  return closed.rows.length;
}

/** Tells who looked at the run that it ended: a run in a thread, the readers of its channel; a run in a conversation, its asker. */
async function announce(ctx: PluginContext, tx: PluginTx, row: Closed): Promise<void> {
  if (row.thread_root_id === null) return;
  const payload = RunEndedPush.parse({ runId: row.run_id, channelId: row.channel_id, threadRootId: row.thread_root_id, status: row.state });
  if (row.conversation) {
    if (row.asker_id === null) return;
    const person = (await tx.query<{ ref_id: string }>("SELECT ref_id FROM app.actors WHERE id = $1::uuid AND kind = 'person'", [row.asker_id])).rows[0]?.ref_id;
    if (person !== undefined) await ctx.realtime.pushToPerson(tx, person, WS_RUN_ENDED, payload);
    return;
  }
  const readers = (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [row.channel_id])).rows.map((r) => r.person_id);
  if (readers.length > 0) await ctx.realtime.pushToPeople(tx, readers, WS_RUN_ENDED, payload);
}

/** Registers the event consumer and the sweep job. */
export function registerRunViewSweep(ctx: PluginContext): void {
  ctx.events.subscribe('bots.run.closed', async (raw, tx) => {
    const runId = (raw as { runId?: unknown }).runId;
    const workspaceId = (raw as { workspaceId?: unknown }).workspaceId;
    if (typeof runId !== 'string' || typeof workspaceId !== 'string') return;
    // the recorder closes its own row a moment later with the exact state; this is for the one that never will
    await closeOverRuns(ctx, tx, { runId, workspaceId });
  });

  ctx.jobs.register(
    SWEEP_QUEUE,
    async (_payload, tx, job) => {
      // which workspaces have an open row for a run that is over, then each in a transaction of its own (the push needs the workspace's audience)
      const stale = await tx.query<{ workspace_id: string }>(
        `SELECT DISTINCT v.workspace_id FROM app.run_view v JOIN app.bot_runs r ON r.id = v.run_id WHERE v.ended_at IS NULL AND r.status <> 'running' LIMIT 50`,
      );
      let n = 0;
      for (const { workspace_id } of stale.rows) n += await ctx.db.system((sys) => closeOverRuns(ctx, sys, { workspaceId: workspace_id }), { workspaceId: workspace_id });
      if (n > 0) job.log.info(`runtime-hermes: ${n} run record(s) closed for runs that were over`);
      // leases nobody renewed (a closed laptop) are not kept
      await tx.query("DELETE FROM app.thread_watchers WHERE expires_at < now() - interval '5 minutes'");
    },
    { cron: '*/2 * * * *', maxAttempts: 1, concurrency: 1 },
  );
}
