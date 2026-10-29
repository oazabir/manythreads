import { definePlugin } from '@manythreads/sdk';
import { createMonitor } from './monitor.ts';
import { MIN_TOKEN_LENGTH, registerRoutes } from './routes.ts';
import { MAIL_QUEUE, TICK_QUEUE, sendAlertMail, tickHealth } from './watcher.ts';

export { DEFAULT_THRESHOLDS, runSlotsLimitFrom, thresholdsFrom, volumesFrom } from './config.ts';
export { describeTransition, evaluate, formatValue } from './evaluate.ts';
export { renderPrometheus } from './prometheus.ts';

/**
 * ops-health: lets the people who run manythreads learn about trouble before its users do. It measures the outbox, the job queue, bot run
 * slots, approvals, model budgets, database connections, memory, event-loop delay and the storage volumes; serves them at `/metrics` for a
 * monitoring system (bearer token, never public) and to workspace admins at `GET /api/admin/health`; and a once-a-minute watcher tells the
 * admins, once, when a number passes its limit and once when it is back. docs/plugins/ops-health.md, docs/deploy/monitoring.md.
 */
export default definePlugin({
  manifest: {
    name: 'ops-health',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'job.register'],
    events: { emits: ['ops.health.changed'], consumes: [] },
    // The tables it reads: approvals (approvals), model budgets and spend (gateway-llm).
    dependsOn: ['approvals', 'gateway-llm'],
  },
  register(ctx) {
    const monitor = createMonitor(ctx, process.env);
    const token = (process.env['MANYTHREADS_METRICS_TOKEN'] ?? '').trim();
    if (token !== '' && token.length < MIN_TOKEN_LENGTH) {
      console.warn(`ops-health: MANYTHREADS_METRICS_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters; /metrics stays switched off`);
    }
    registerRoutes(ctx, monitor);
    ctx.jobs.register(
      TICK_QUEUE,
      async (_payload, tx, job) => {
        const n = await tickHealth(ctx, tx, monitor, process.env);
        if (n > 0) job.log.warn(`ops-health: ${n} health change(s) announced`);
      },
      { cron: '* * * * *', maxAttempts: 1, concurrency: 1 },
    );
    ctx.jobs.register(MAIL_QUEUE, async (payload, _unusable, job) => sendAlertMail(ctx, payload, job), { detached: true, maxAttempts: 4, concurrency: 1 });
  },
});
