import type { PluginContext, PluginTx } from '@manythreads/sdk';

// The stale-run reaper (PLAN P5-13 review). A run whose worker died stays `running` for ever: nothing closes it, so everything that waits for runs
// to end (the memory feed holds a bot's output back while one of its runs is open) waits with it. Hourly, every run still `running` past its bot's
// `limits.timeoutSeconds` plus a grace period — or six hours when the definition names no limit — is closed `failed` through the run service,
// the same path every run takes, so `bots.run.closed` is emitted and its endpoint token is revoked.

export const REAP_QUEUE = 'bots.reap-runs';
/** The limit assumed for a bot whose definition names none. */
export const DEFAULT_RUN_LIMIT_SECONDS = 6 * 60 * 60;
/** A run that is merely slow to finish is not reaped: this much beyond its limit first. */
export const RUN_GRACE_SECONDS = 10 * 60;
/** Runs closed per pass; the rest wait for the next hour. */
export const REAP_BATCH = 200;

export async function reapStaleRuns(ctx: PluginContext, tx: PluginTx): Promise<number> {
  const stale = await tx.query<{ id: string }>(
    `SELECT r.id
       FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id
      WHERE r.status = 'running' AND r.ended_at IS NULL
        AND r.started_at < now() - make_interval(secs => coalesce(b.run_timeout_seconds, $1) + $2)
      ORDER BY r.started_at LIMIT $3`,
    [DEFAULT_RUN_LIMIT_SECONDS, RUN_GRACE_SECONDS, REAP_BATCH],
  );
  let closed = 0;
  for (const row of stale.rows) {
    if (await ctx.runs.close(row.id, 'failed')) closed += 1;
  }
  return closed;
}

export function registerReaperJob(ctx: PluginContext): void {
  ctx.jobs.register(
    REAP_QUEUE,
    async (_payload, tx, job) => {
      const closed = await reapStaleRuns(ctx, tx);
      if (closed > 0) job.log.info(`bots: ${closed} stale run(s) closed as failed`);
    },
    { cron: '41 * * * *', maxAttempts: 1, concurrency: 1 },
  );
}
