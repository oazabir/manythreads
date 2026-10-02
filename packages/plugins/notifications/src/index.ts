import { definePlugin } from '@manythreads/sdk';
import { registerConsumers } from './consumers.ts';
import { registerRoutes } from './routes.ts';

/**
 * Notifications: the inbox behind the bell (SPEC section 3, PLAN P3-09). Mentions, replies in followed threads and direct messages become
 * one notification per message and person, pushed live to the person's sockets. docs/plugins/notifications.md lists the rules, routes,
 * pushes and the event.
 */
export default definePlugin({
  manifest: {
    name: 'notifications',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe'],
    events: {
      emits: ['notifications.notification.created'],
      consumes: ['channel.mention.created', 'channel.message.posted', 'channel.message.deleted', 'channel.member.removed'],
    },
    dependsOn: ['channels'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerRoutes(ctx);
    registerConsumers(ctx);
  },
});
