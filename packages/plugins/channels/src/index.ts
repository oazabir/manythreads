import { definePlugin } from '@manythreads/sdk';
import { registerMessageCapabilities } from './capabilities.ts';
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
    // `messages.post` (PLAN P5-10): how a bot's runtime posts a reply into a thread. Not destructive — it adds a message like
    // any other — and `messages.search` stays the search plugin's (it owns the index).
    capabilities: [{ name: 'messages.post', destructive: false }],
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
    registerMessageCapabilities(deps);
  },
});
