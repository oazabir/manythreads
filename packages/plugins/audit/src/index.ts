import { definePlugin, type EventMeta, type PluginEvent } from '@manythreads/sdk';
import { draftOfEvent, writeDrafts } from './project.ts';
import { registerRoutes } from './routes.ts';
import { AUDITED_EVENT_TYPES } from './spec.ts';
import { SWEEP_QUEUE, backfillEvents, sweepMemoryLog } from './sweep.ts';

export { draftOfEvent, draftOfMemoryLine, rowsOf, writeDrafts } from './project.ts';
export { AUDITED_EVENT_TYPES, MAPPERS } from './spec.ts';
export { backfillEvents, sweepMemoryLog } from './sweep.ts';

/**
 * audit: the audit console. It turns the event log (and the memory plugin's log of what it held back) into content-blind rows that answer "who did what,
 * when, to what, and what was withheld", lets workspace admins filter and page through them at `GET /api/admin/audit`, and exports them as a signed
 * file at `POST /api/admin/audit/export`. It is a projection, not a second source of truth. docs/plugins/audit.md.
 */
export default definePlugin({
  manifest: {
    name: 'audit',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.subscribe', 'event.emit', 'job.register', 'secret.seal'],
    events: { emits: ['audit.export.created'], consumes: [...AUDITED_EVENT_TYPES] },
    // The names it shows come from the bots and channels tables, and the memory log is the memory plugin's.
    dependsOn: ['bots', 'channels', 'memory'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    for (const type of AUDITED_EVENT_TYPES) {
      ctx.events.subscribe(type, async (event: PluginEvent, tx, meta?: EventMeta) => {
        if (!meta) return;
        const draft = draftOfEvent(event, meta, tx.actor.workspaceId);
        if (draft) await writeDrafts(tx, [draft]);
      });
    }
    ctx.jobs.register(
      SWEEP_QUEUE,
      async (_payload, tx, job) => {
        const memory = await sweepMemoryLog(tx);
        const history = await backfillEvents(tx);
        if (memory + history > 0) job.log.info(`audit: ${memory} memory line(s) and ${history} historic event(s) added`);
      },
      { cron: '* * * * *', maxAttempts: 1, concurrency: 1 },
    );
  },
});
