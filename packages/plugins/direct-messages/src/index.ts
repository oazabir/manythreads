import { definePlugin } from '@manythreads/sdk';
import { registerDmRoutes } from './routes.ts';

/**
 * Direct messages: open (get-or-create) a private conversation with one or more people, and list mine (SPEC section 6.1,
 * PLAN P3-06). A DM is a channel of kind `dm` owned by the channels plugin; this plugin owns the one door that creates it
 * (migration 0001), see docs/plugins/direct-messages.md.
 */
export default definePlugin({
  manifest: {
    name: 'direct-messages',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit'],
    events: { emits: ['channel.channel.created'], consumes: [] },
    dependsOn: ['channels'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerDmRoutes(ctx);
  },
});
