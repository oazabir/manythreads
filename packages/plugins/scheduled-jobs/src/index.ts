import { definePlugin } from '@manythreads/sdk';
import { failStuckFirings, registerLedger } from './ledger.ts';
import { registerRoutes } from './routes.ts';
import { TICK_QUEUE, tickScheduledJobs } from './scheduler.ts';

export { RoutineContract, TICK_QUEUE, nextRunFor, startScheduledJobRun, tickScheduledJobs } from './scheduler.ts';

/**
 * scheduled jobs: heartbeat, routine and task schedules (PLAN P6-08; SPEC §6.5). The tick job advances `next_run_at` and files a run per due scheduled job;
 * a routine's contract is checked first, so a bad one becomes a `failed` run with the reason instead of a worker doing something wrong. The
 * runtime (`runtime-hermes`) picks a queued run up from the `scheduled_jobs.scheduled_job.ran` event and starts the bot; the ledger follows the runtime's
 * `runtime.scheduled_job.*` events (see ledger.ts). The Jobs screen arrives with the rest of phase 6's UI. docs/plugins/scheduled-jobs.md.
 */
export default definePlugin({
  manifest: {
    name: 'scheduled-jobs',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe', 'job.register'],
    capabilities: [],
    events: { emits: ['scheduled_jobs.scheduled_job.ran'], consumes: ['runtime.scheduled_job.started', 'runtime.scheduled_job.finished', 'bots.run.closed'] },
    dependsOn: ['bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    registerLedger(ctx);
    ctx.jobs.register(
      TICK_QUEUE,
      async (_payload, tx, job) => {
        const n = await tickScheduledJobs(ctx, tx, new Date());
        if (n > 0) job.log.info(`scheduledJobs: ${n} scheduledJob(s) fired`);
        const stuck = await failStuckFirings(ctx, tx, new Date());
        if (stuck > 0) job.log.warn(`scheduledJobs: ${stuck} firing(s) failed for taking too long`);
      },
      { cron: '* * * * *' },
    );
  },
});
