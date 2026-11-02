import { definePlugin, type EventMeta, type PluginEvent } from '@manythreads/sdk';
import { analyticsEnabled } from './config.ts';
import { CONSUMED_EVENTS, rowsOfEvent } from './emitters.ts';
import { registerRoutes } from './routes.ts';
import { PARTITIONS_QUEUE, RETAIN_QUEUE, ROLLUP_QUEUE, SWEEP_QUEUE, ensurePartitions, retainEvents, rollupDays, sweepSources } from './sweep.ts';
import { appendRows } from './write.ts';

export { analyticsEnabled, eventMonths, oldestKeptMonth } from './config.ts';
export { CONSUMED_EVENTS, rowsOfEvent } from './emitters.ts';
export { PARTITIONS_QUEUE, RETAIN_QUEUE, ROLLUP_QUEUE, SWEEP_QUEUE, ensurePartitions, labelSql, retainEvents, rollupDays, rollupRange, sweepSources } from './sweep.ts';
export { aliasesOf, botRowsOf, dailyOf, qualityOf, readSeries, signInsOf, teamRowsOf, totalsOf, usageRange } from './usage.ts';
export { appendRows, cleanDims, derivedId, ensureMonths, monthsBetween, type EventRow } from './write.ts';

/**
 * analytics: usage numbers. It counts what the platform already records — a model call's cost, a run that ended, a tool call, an approval, an answer, a
 * knowledge document reached, a sign-in — into a monthly-partitioned time-series table, adds them up per day, and serves the usage pages (workspace, team,
 * bot, Brain quality). Counts, ids and amounts only: never what was said, read or written. docs/plugins/analytics.md.
 */
export default definePlugin({
  manifest: {
    name: 'analytics',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.subscribe', 'job.register'],
    events: { emits: [], consumes: [...CONSUMED_EVENTS] },
    // bots (runs, their decisions and source log, the bot names), gateway-llm (the spend ledger and the budgets), approvals (an approval's wait).
    dependsOn: ['bots', 'gateway-llm', 'approvals'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);

    for (const type of CONSUMED_EVENTS) {
      ctx.events.subscribe(type, async (event: PluginEvent, tx, meta?: EventMeta) => {
        if (!meta || !analyticsEnabled()) return;
        await appendRows(tx, await rowsOfEvent(event, meta, tx), ctx.runtime.now());
      });
    }

    // Partitions for this month and the next two, every day (a write also makes the month it needs, so this is the safety margin, not the only door).
    ctx.jobs.register(
      PARTITIONS_QUEUE,
      async (_payload, tx, job) => {
        if (!analyticsEnabled()) return;
        const months = await ensurePartitions(tx, ctx.runtime.now());
        job.log.info(`analytics: partitions ready for ${months.join(', ')}`);
      },
      { cron: '17 2 * * *', maxAttempts: 2, concurrency: 1 },
    );

    // The tables no event covers (the spend ledger, a run's tool decisions, the knowledge a run reached): read every five minutes from where it stopped.
    ctx.jobs.register(
      SWEEP_QUEUE,
      async (_payload, tx, job) => {
        if (!analyticsEnabled()) return;
        const results = await sweepSources(tx, ctx.runtime.now());
        const stored = results.reduce((n, r) => n + r.stored, 0);
        if (stored > 0) job.log.info(`analytics: ${stored} new row(s) from ${results.filter((r) => r.stored > 0).map((r) => r.source).join(', ')}`);
      },
      { cron: '*/5 * * * *', maxAttempts: 2, concurrency: 1 },
    );

    // Hourly: yesterday and today added up into the daily rows.
    ctx.jobs.register(
      ROLLUP_QUEUE,
      async (_payload, tx, job) => {
        if (!analyticsEnabled()) return;
        const r = await rollupDays(tx, ctx.runtime.now());
        job.log.info(`analytics: ${r.groups} daily row(s) written for ${r.from} to ${r.to}`);
      },
      { cron: '7 * * * *', maxAttempts: 2, concurrency: 1 },
    );

    // Daily: detach the months past the window (their days stay in the daily rows).
    ctx.jobs.register(
      RETAIN_QUEUE,
      async (_payload, tx, job) => {
        if (!analyticsEnabled()) return;
        const detached = await retainEvents(tx, ctx.runtime.now());
        if (detached.length > 0) job.log.info(`analytics: detached ${detached.join(', ')}`);
      },
      { cron: '37 3 * * *', maxAttempts: 2, concurrency: 1 },
    );
  },
});
