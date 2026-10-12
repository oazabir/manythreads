import { definePlugin } from '@manythreads/sdk';
import { STUB_CAPABILITIES, TOOLS } from './catalog.ts';
import { registerMcpRoutes } from './routes.ts';

export { TOOLS, STUB_CAPABILITIES, definitionOf, withRunTeam } from './catalog.ts';
export type { ToolDefinition, ToolKind, ToolSource } from './catalog.ts';
export { handleRpc, toolResult } from './protocol.ts';
export { registerMcpRoutes } from './routes.ts';

/**
 * gateway-mcp: the one MCP endpoint a bot's run calls its tools through (SPEC §11, PLAN P5-09). The runtime asks
 * for a run with the bot's pairing token and gets a URL and a token for that run alone; every call to it is
 * resolved back to the run, so a tool call can always be attributed — to the bot for what it may do, to the asking
 * person for what it may see — and every hit a read answers with lands in `run_source_log`. The tools are the
 * capabilities plugins registered, checked one by one by the kernel's broker; the JSON-RPC face is in
 * `src/protocol.ts` and the shapes on the wire are HTTP's (docs/plugins/gateway-mcp.md).
 *
 * It also declares, for now, the capabilities whose owning plugin does not exist yet — `knowledge.search`
 * (answering an empty result with the reason, which SPEC §12.4 asks for until bases are configured) and the four
 * `tasks.*` names (answering that the board is not part of this deployment). Both are stubs by construction: they
 * never invent content, and when their plugins land they take the declaration over.
 */
export default definePlugin({
  manifest: {
    name: 'gateway-mcp',
    version: '0.1.0',
    kind: 'server',
    extends: ['tool.invoke'],
    capabilities: STUB_CAPABILITIES.map((name) => ({ name, destructive: false })),
    // app.mcp_run_tokens references app.bot_runs and app.bots: this plugin's migration needs the bots namespace first.
    dependsOn: ['bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    for (const name of STUB_CAPABILITIES) {
      const answer = TOOLS[name]?.answer ?? { ok: false, code: 'not_available' };
      ctx.capabilities.register(name, async () => answer);
    }
    registerMcpRoutes(ctx);
  },
});
