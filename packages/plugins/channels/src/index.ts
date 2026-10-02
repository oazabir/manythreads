import { definePlugin } from '@manythreads/sdk';
import { registerCohesion } from './cohesion.ts';
import { registerChannelRoutes } from './routes-channels.ts';
import { registerEphemeralRoutes } from './routes-ephemeral.ts';
import { registerMessageRoutes } from './routes-messages.ts';
import { registerTemplateConsumer } from './templates.ts';

/**
 * Channels: groups, channels, membership, messages, reactions, mentions, presence and typing, and the live pushes (SPEC section 6.1, PLAN P3-01, P3-02, P3-05, P3-07).
 * Every mutation emits a registry event as the caller; docs/plugins/channels.md lists the routes, events and pushes.
 */
export default definePlugin({
  manifest: {
    name: 'channels',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe'],
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
      ],
      consumes: ['team.template.applied'],
    },
    migrations: 'migrations',
  },
  register(ctx) {
    const deps = { ctx };
    registerChannelRoutes(deps);
    registerMessageRoutes(deps);
    registerEphemeralRoutes(deps);
    registerTemplateConsumer(ctx);
    registerCohesion(ctx);
  },
});
