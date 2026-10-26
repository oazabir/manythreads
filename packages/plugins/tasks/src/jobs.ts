import type { PluginContext } from '@manythreads/sdk';

/**
 * `tasks.claim-timeout` (PLAN P6-02): a claim that was never released is released by the platform, not kept forever. The database does the
 * release (`app.tasks_expire_claims`) so a crashed worker cannot leave a card owned by nobody who is working on it. The same tick marks a
 * runner that stopped heartbeating offline, so the Servers screen never shows a dead process as available.
 */
export const CLAIM_SWEEP_QUEUE = 'tasks.claim-timeout';

export function registerJobs(ctx: PluginContext): void {
  ctx.jobs.register(
    CLAIM_SWEEP_QUEUE,
    async (_payload, tx, job) => {
      const released = (await tx.query<{ n: number }>('SELECT app.tasks_expire_claims() AS n')).rows[0]?.n ?? 0;
      const offline = (await tx.query<{ n: number }>("UPDATE app.runners SET status = 'offline' WHERE status = 'online' AND coalesce(last_seen_at, registered_at) < now() - interval '90 seconds' RETURNING 1 AS n")).rows.length;
      // Private notes of done cards, of handovers older than a week, and sealed notes that never got attached.
      const notes = (await tx.query<{ n: number }>('SELECT app.tasks_sweep_private_notes(7) AS n')).rows[0]?.n ?? 0;
      job.log.info(`tasks sweep: ${released} claim(s) released, ${offline} runner(s) offline, ${notes} private note(s) deleted`);
    },
    { cron: '* * * * *' },
  );
}
