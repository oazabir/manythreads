import { definePlugin } from '@manythreads/sdk';
import { FIRE_CRON, FIRE_QUEUE, fireDue } from './fire.ts';
import { registerLaterRoutes } from './routes.ts';
import { registerRemindRoutes } from './routes-remind.ts';
import { SEND_CRON, SEND_QUEUE, pruneHistory, sendDue } from './send.ts';

/**
 * Reminders: Later, and `/remind`. A person saves a message to come back to, with or without a time at which they are reminded (PLAN P14-04). The
 * items are private to the person; a minute job fires the due reminders as `reminders.reminder.due` events, which the notifications plugin turns into
 * a notification (in the bell, live, and as a browser push when the person signed one up). `/remind` makes a reminder of plain text for the person, for
 * another person or for a channel; a second minute job delivers each as a message from the "Reminders" sender. docs/plugins/reminders.md lists the rules.
 */
export default definePlugin({
  manifest: {
    name: 'reminders',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'job.register'],
    events: { emits: ['reminders.reminder.due', 'reminders.reminder.changed'], consumes: [] },
    // The messages and channels a saved item points at, and `app.message_authors` / `app.channel_audience`, belong to the channels plugin.
    // `webhooks` (which depends on `bots`): migration 0002 replaces `app.message_authors` on top of webhooks 0002 to name the "Reminders" sender, so
    // it must run after the migrations that last replaced it.
    dependsOn: ['channels', 'webhooks'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerLaterRoutes(ctx);
    registerRemindRoutes(ctx);
    // Every minute: fire the reminders whose time has come.
    ctx.jobs.register(
      FIRE_QUEUE,
      async (_payload, tx, job) => {
        const fired = await fireDue(ctx, tx, ctx.runtime.now());
        if (fired > 0) job.log.info(`reminders: ${fired} reminder(s) due`);
      },
      { cron: FIRE_CRON, maxAttempts: 1 },
    );
    // Every minute: deliver the `/remind` reminders whose time has come, each as the "Reminders" sender (send.ts), and drop old finished ones.
    ctx.jobs.register(
      SEND_QUEUE,
      async (_payload, _unusable, job) => {
        const done = await sendDue(ctx, (fn) => job.transaction(fn), ctx.runtime.now(), job.log);
        if (done.sent + done.refused + done.failed + done.deferred + done.errors > 0) {
          job.log.info(`reminders: ${done.sent} reminder(s) sent, ${done.refused} refused, ${done.failed} failed to be retried, ${done.deferred} waiting for a busy door, ${done.errors} not handled`);
        }
        const removed = await pruneHistory((fn) => job.transaction(fn));
        if (removed > 0) job.log.info(`reminders: ${removed} old finished reminder(s) removed`);
      },
      // detached: the run is a list and then a few short transactions per reminder, never one held open; one run at a time in this process
      { cron: SEND_CRON, maxAttempts: 1, concurrency: 1, detached: true },
    );
  },
});
