import { definePlugin } from '@manythreads/sdk';
import { registerRoutes } from './routes.ts';
import { TICK_QUEUE, tickRhythms } from './scheduler.ts';

export { RoutineContract, TICK_QUEUE, nextRunFor, startRhythmRun, tickRhythms } from './scheduler.ts';

/**
 * rhythms: heartbeat, routine and task schedules (PLAN P6-08; SPEC §6.5). The tick job advances `next_run_at` and files a run per due rhythm;
 * a routine's contract is checked first, so a bad one becomes a `failed` run with the reason instead of a worker doing something wrong. The
 * runtime that picks a queued run up (and the Rhythms screen) arrive with the rest of phase 6's UI; the API, the schedule and the run
 * ledger are here. docs/plugins/rhythms.md.
 */
export default definePlugin({
  manifest: {
    name: 'rhythms',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'job.register'],
    capabilities: [],
    events: { emits: ['rhythms.rhythm.ran'], consumes: [] },
    dependsOn: ['bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    ctx.jobs.register(
      TICK_QUEUE,
      async (_payload, tx, job) => {
        const n = await tickRhythms(ctx, tx, new Date());
        if (n > 0) job.log.info(`rhythms: ${n} rhythm(s) fired`);
      },
      { cron: '* * * * *' },
    );
  },
});
