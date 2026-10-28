import { definePlugin } from '@manythreads/sdk';
import { registerHeartbeatRoutes } from './heartbeat.ts';
import { registerStatusRoutes } from './routes.ts';

/**
 * Presence: who is here and what they say about themself. The heartbeat (active or away), a custom status, a time zone with working hours,
 * an out-of-office note and Do not disturb (PLAN P14-01). The notifications plugin reads the Do not disturb settings to hold messages and
 * releases them when it ends. docs/plugins/presence.md lists the tables, routes and the event.
 */
export default definePlugin({
  manifest: {
    name: 'presence',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit'],
    events: { emits: ['presence.dnd.changed'], consumes: [] },
    // The heartbeat table `app.presence` is channels' (migration 0003): this plugin owns its routes.
    dependsOn: ['channels'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerHeartbeatRoutes(ctx);
    registerStatusRoutes(ctx);
  },
});
