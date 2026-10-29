import { definePlugin } from '@manythreads/sdk';
import { registerConsumers } from './consumers.ts';
import { RELEASE_HELD_CRON, RELEASE_HELD_QUEUE, releaseDue } from './hold.ts';
import { PUSH_QUEUE, runPushJob } from './push.ts';
import { registerRoutes } from './routes.ts';
import { registerPreferenceRoutes } from './routes-prefs.ts';

/**
 * Notifications: the inbox behind the bell (SPEC section 3, PLAN P3-09). Mentions, replies in followed threads and direct messages become
 * one notification per message and person, pushed live to the person's sockets and, for browsers signed up for it, as a browser push; a channel's
 * level (all, mentions, nothing) and a person's keywords decide who is told; during Do not disturb they are held and delivered when it ends. docs/plugins/notifications.md lists the rules, routes, pushes and the event.
 */
export default definePlugin({
  manifest: {
    name: 'notifications',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe', 'job.register'],
    events: {
      emits: ['notifications.notification.created'],
      consumes: ['channel.mention.created', 'channel.message.posted', 'channel.message.deleted', 'channel.member.removed', 'presence.dnd.changed'],
    },
    // presence: the Do not disturb settings a message is held by (`dnd_settings`, `person_status.time_zone`).
    dependsOn: ['channels', 'presence'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    registerPreferenceRoutes(ctx);
    registerConsumers(ctx);
    // Every minute: release what was held for people whose Do not disturb has ended by the clock (a pause ran out, a schedule closed).
    ctx.jobs.register(
      RELEASE_HELD_QUEUE,
      async (_payload, tx, job) => {
        const released = await releaseDue(ctx, tx, ctx.runtime.now());
        if (released > 0) job.log.info(`notifications: released ${released} held notification(s)`);
      },
      { cron: RELEASE_HELD_CRON, maxAttempts: 1 },
    );
    // Browser push, one job per notification and person; it talks to the browsers' push services, so it holds no transaction while it waits.
    ctx.jobs.register(PUSH_QUEUE, async (payload, _unusable, job) => runPushJob(ctx, payload, job), { detached: true, maxAttempts: 4, concurrency: 4 });
  },
});
