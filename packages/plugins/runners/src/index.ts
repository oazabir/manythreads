import { definePlugin } from '@manythreads/sdk';
import { ConnectionRegistry } from './connections.ts';
import { createRunnerDoor } from './door.ts';
import { registerRunnerRoutes } from './routes.ts';

export { HEARTBEAT_SECONDS, ConnectionRegistry } from './connections.ts';
export { bearerRunnerToken, hashRunnerToken, newRunnerToken } from './tokens.ts';

/**
 * runners: the machines outside the cluster that run agents (SPEC §7.4, PLAN P6-06). A runner is one program on one machine, holding one
 * outbound WebSocket to the server and advertising what it can do; a bot whose `placement.runner` names it has its runs executed there.
 * This plugin mints and revokes a runner's token (the credential it connects with), owns the connections, and registers the `runner`
 * provider that `runtime-hermes` sends a job through. The `runners` table itself belongs to the tasks plugin. docs/plugins/runners.md.
 */
export default definePlugin({
  manifest: {
    name: 'runners',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.runner', 'event.emit'],
    events: { emits: ['runners.runner.connected', 'runners.runner.disconnected', 'runners.job.refused', 'runners.token.minted', 'runners.token.revoked'], consumes: [] },
    // app.runners is the tasks plugin's table; this plugin's token table references it.
    dependsOn: ['tasks', 'teams'],
    migrations: 'migrations',
  },
  register(ctx) {
    const registry = new ConnectionRegistry();
    ctx.providers.register('runner', createRunnerDoor(ctx, registry));
    registerRunnerRoutes(ctx, registry);
  },
});
