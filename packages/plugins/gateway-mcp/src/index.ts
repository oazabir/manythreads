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
 * It declares no capability of its own any more: `knowledge.search`, its last stub, is the knowledge plugin's now, and the
 * `tasks.*` tools are the tasks plugin's. This catalog only describes them (PLAN P6-02, P8-08).
 */
export default definePlugin({
  manifest: {
    name: 'gateway-mcp',
    version: '0.1.0',
    kind: 'server',
    extends: ['tool.invoke', 'hook.pre_egress', 'event.emit'],
    events: { emits: ['guardrails.dlp.decided'], consumes: [] },
    capabilities: STUB_CAPABILITIES.map((name) => ({ name, destructive: false })),
    // app.mcp_run_tokens references app.bot_runs and app.bots: this plugin's migration needs the bots namespace first.
    // guardrails-dlp reads what a call carries (the pre_egress chain); without it every call that carries text is refused.
    dependsOn: ['bots', 'guardrails-dlp'],
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
