import { definePlugin } from '@manythreads/sdk';
import { registerMessageCapabilities, registerMessageProvider } from './capabilities.ts';
import { registerCohesion } from './cohesion.ts';
import { registerBookmarkRoutes } from './routes-bookmarks.ts';
import { registerChannelRoutes } from './routes-channels.ts';
import { registerEphemeralRoutes } from './routes-ephemeral.ts';
import { registerMentionRoutes } from './routes-mentions.ts';
import { registerMessageRoutes } from './routes-messages.ts';
import { registerScheduledRoutes } from './routes-scheduled.ts';
import { registerSidebarRoutes } from './routes-sidebar.ts';
import { SEND_CRON, SEND_QUEUE, sendDue } from './scheduled.ts';
import { registerTemplateConsumer } from './templates.ts';

/**
 * Channels: groups, channels, membership, messages, reactions, mentions, presence and typing, and the live pushes (SPEC section 6.1, PLAN P3-01, P3-02, P3-05, P3-07).
 * Scheduled send (P14-05) adds the `channels.send_scheduled` minute job. Every mutation emits a registry event as the caller; docs/plugins/channels.md lists the routes, events and pushes.
 */
export default definePlugin({
  manifest: {
    name: 'channels',
    version: '0.1.0',
    kind: 'server',
    // `provider.messages`: the one path a message is written on, for plugins that finish a bot's reply with more than text (PLAN P5-18).
    extends: ['event.emit', 'event.subscribe', 'provider.messages', 'job.register'],
    // `messages.post` (PLAN P5-10): how a bot's runtime posts a reply into a thread. Not destructive — it adds a message like
    // any other — and `messages.search` stays the search plugin's (it owns the index).
    capabilities: [
      { name: 'messages.post', destructive: false },
      // `messages.update`: a bot edits a message it posted itself (a checklist kept current); never wakes anyone.
      { name: 'messages.update', destructive: false },
    ],
    events: {
      emits: [
        'channel.message.posted',
        'channel.message.edited',
        'channel.message.deleted',
        'channel.reaction.changed',
        'channel.channel.created',
        'channel.channel.updated',
        'channel.channel.archived',
        'channel.member.added',
        'channel.member.removed',
        'channel.mention.created',
        'channel.scheduled_message.changed',
      ],
      consumes: ['team.template.applied'],
    },
    migrations: 'migrations',
  },
  register(ctx) {
    const deps = { ctx };
    registerChannelRoutes(deps);
    registerMessageRoutes(deps);
    registerMentionRoutes(deps);
    registerBookmarkRoutes(deps);
    registerScheduledRoutes(deps);
    registerSidebarRoutes(deps);
    registerEphemeralRoutes(deps);
    registerTemplateConsumer(ctx);
    registerCohesion(ctx);
    registerMessageCapabilities(deps);
    registerMessageProvider(deps);
    // Every minute: post the scheduled messages whose time has come, each as its author (PLAN P14-05; scheduled.ts).
    ctx.jobs.register(
      SEND_QUEUE,
      async (_payload, _unusable, job) => {
        const done = await sendDue(deps, (fn) => job.transaction(fn), ctx.runtime.now(), job.log);
        if (done.sent + done.refused + done.failed + done.deferred + done.errors > 0) {
          job.log.info(`channels: ${done.sent} scheduled message(s) sent, ${done.refused} refused, ${done.failed} failed to be retried, ${done.deferred} waiting for a busy door, ${done.errors} not handled`);
        }
      },
      // detached: the run is many short transactions (a list, then one per message), never one held open; one run at a time in this process
      { cron: SEND_CRON, maxAttempts: 1, concurrency: 1, detached: true },
    );
  },
});
