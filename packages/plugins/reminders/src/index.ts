import { definePlugin } from '@manythreads/sdk';
import { FIRE_CRON, FIRE_QUEUE, fireDue } from './fire.ts';
import { registerLaterRoutes } from './routes.ts';

/**
 * Reminders: Later. A person saves a message to come back to, with or without a time at which they are reminded (PLAN P14-04). The items are
 * private to the person; a minute job fires the due reminders as `reminders.reminder.due` events, which the notifications plugin turns into
 * a notification (in the bell, live, and as a browser push when the person signed one up). docs/plugins/reminders.md lists the rules.
 */
export default definePlugin({
  manifest: {
    name: 'reminders',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'job.register'],
    events: { emits: ['reminders.reminder.due'], consumes: [] },
    // The messages and channels a saved item points at, and `app.message_authors` / `app.channel_audience`, belong to the channels plugin.
    dependsOn: ['channels'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerLaterRoutes(ctx);
    // Every minute: fire the reminders whose time has come.
    ctx.jobs.register(
      FIRE_QUEUE,
      async (_payload, tx, job) => {
        const fired = await fireDue(ctx, tx, ctx.runtime.now());
        if (fired > 0) job.log.info(`reminders: ${fired} reminder(s) due`);
      },
      { cron: FIRE_CRON, maxAttempts: 1 },
    );
  },
});
