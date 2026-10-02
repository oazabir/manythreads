import { definePlugin } from '@manythreads/sdk';
import { registerThreadRoutes } from './routes.ts';

/**
 * Threads: read a thread (root and replies), follow and unfollow it, and the Threads inbox (Followed, Unread, Mine) of a team
 * (SPEC section 6.1, PLAN P3-06). Tables and the reply path belong to the channels plugin; see docs/plugins/threads.md.
 */
export default definePlugin({
  manifest: {
    name: 'threads',
    version: '0.1.0',
    kind: 'server',
    dependsOn: ['channels'],
  },
  register(ctx) {
    registerThreadRoutes(ctx);
  },
});
