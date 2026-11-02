import { definePlugin, type PluginEvent } from '@manythreads/sdk';
import { compileBot, dropBot, type Declared } from './compile.ts';
import { registerRoutes } from './routes.ts';
import { createConnectionsSource } from './source.ts';

export { compileBot, compileTeam, dropBot } from './compile.ts';
export { inputProblem, kindOf, kindServes, TOOLS } from './kinds.ts';
export { deleteConnectionAndSecrets, putConnectionSecret, readConnectionSecret } from './secrets.ts';

/**
 * connections: a team's links to outside services, and the tools a bot gets from them (PLAN P8-01, P8-28). A connection holds the place and the sealed
 * credentials; a grant says which bot may call which of its tools; this plugin is the source those tools come from (`ctx.toolSources`), so the MCP gateway lists
 * them for a bot that has a grant and hands the call here after the capability broker allowed it. It compiles `capabilities.connections` of each BOT.md into the
 * grants when the bot is loaded. The only kind today is `email`, a stub until the mail transport exists. docs/plugins/connections.md.
 */
export default definePlugin({
  manifest: {
    name: 'connections',
    version: '0.1.0',
    kind: 'server',
    migrations: 'migrations',
    // tool.source: this plugin offers tools to bots; secret.seal: credentials are sealed by the platform's secret service; event.subscribe: the compile
    extends: ['tool.source', 'secret.seal', 'event.subscribe'],
    events: { emits: [], consumes: ['bots.bot.loaded', 'bots.bot.removed'] },
    // Every tool a connection can serve is a capability the broker knows by name. None is destructive: a tool that deletes outside data is not offered through a
    // connection (the compile refuses a destructive tool, and the broker never grants one).
    capabilities: [
      { name: 'email.read', destructive: false },
      { name: 'email.draft', destructive: false },
      { name: 'email.send', destructive: false },
    ],
    // app.connection_grants references app.team_members (teams) and the compile reads app.bots and its projection (bots)
    dependsOn: ['teams', 'bots'],
  },
  register(ctx) {
    const declared: Declared = new Map(ctx.manifest.capabilities.map((c) => [c.name, { destructive: c.destructive }]));
    ctx.toolSources.register(createConnectionsSource({ db: ctx.db, secrets: ctx.secrets }));

    // Runs as the system actor in the outbox consumer, after the loader committed the bot's row and its projection; idempotent, so a redelivery changes nothing.
    ctx.events.subscribe('bots.bot.loaded', async (event: PluginEvent, tx) => {
      const { workspaceId, teamId, botId } = event as PluginEvent & { workspaceId?: unknown; teamId?: unknown; botId?: unknown };
      if (typeof workspaceId !== 'string' || typeof teamId !== 'string' || typeof botId !== 'string') return;
      await compileBot(tx, declared, { workspaceId, teamId, botId });
    });
    ctx.events.subscribe('bots.bot.removed', async (event: PluginEvent, tx) => {
      const { workspaceId, botId } = event as PluginEvent & { workspaceId?: unknown; botId?: unknown };
      if (typeof workspaceId !== 'string' || typeof botId !== 'string') return;
      await dropBot(tx, { workspaceId, botId });
    });

    registerRoutes(ctx);
  },
});
