import { definePlugin, type McpToolsProvider, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import { STUB_CAPABILITIES, TOOLS } from './catalog.ts';
import { callTool, offeredTools } from './protocol.ts';
import { registerMcpRoutes } from './routes.ts';
import { sandboxMembers } from './sandbox.ts';
import { createMcpSessions, sessionSecretFromEnv } from './session.ts';
import { createStreamHub, type StreamHub } from './streams.ts';
import { currentToolsDigest, readVersions, refreshPushedDigest, stillValidTokens } from './tools-state.ts';

export { TOOLS, STUB_CAPABILITIES, definitionOf, withRunTeam } from './catalog.ts';
export type { ToolDefinition, ToolKind, ToolSource } from './catalog.ts';
export { handleRpc, toolResult } from './protocol.ts';
export { registerMcpRoutes } from './routes.ts';
export { toolsDigest } from './digest.ts';

/**
 * Re-reads a bot's tool list when something that decides it changed, and keeps the new digest. The streams of every replica look at that digest's counter and
 * push `list_changed` when it moved; the wake-up is delayed a moment so it runs after this transaction has committed.
 */
function watchToolChanges(ctx: PluginContext, hub: StreamHub): void {
  const refresh = async (tx: PluginTx, botIds: readonly string[]): Promise<void> => {
    let moved = false;
    for (const botId of botIds) moved = ((await refreshPushedDigest(ctx, tx, botId))?.changed ?? false) || moved;
    if (moved) setTimeout(() => hub.wake(), 100).unref();
  };
  // Reading a bot's list asks the broker for each grant, and the broker reads on a connection of its own: inside the event's transaction that sees
  // none of the grants written in it, and a template that loads many bots at once holds every pooled connection while each waits for one more. So the
  // refresh runs after the event's transaction has ended, one bot at a time.
  const pending = new Set<string>();
  let draining: Promise<void> | null = null;
  const drain = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    while (pending.size > 0) {
      const [botId] = pending;
      if (botId === undefined) break;
      pending.delete(botId);
      try {
        await ctx.db.system((tx) => refresh(tx, [botId]));
      } catch {
        // the next look at the bot's list (tools/list) keeps the digest; a missed push is only a later one
      }
    }
  };
  const refreshAfterCommit = (botIds: readonly string[]): void => {
    for (const botId of botIds) pending.add(botId);
    draining ??= drain().finally(() => {
      draining = null;
      if (pending.size > 0) refreshAfterCommit([]);
    });
  };
  // a bot's BOT.md was loaded: its grants (and the approval flag on each) were compiled in the transaction that wrote this event
  ctx.events.subscribe('bots.bot.loaded', async (event: PluginEvent) => {
    const botId = (event as PluginEvent & { botId?: unknown }).botId;
    if (typeof botId === 'string') refreshAfterCommit([botId]);
  });
  // the data-protection policy was changed: the bots that have used the event stream are read again (a bot that never has needs nothing kept)
  ctx.events.subscribe('guardrails.policy.updated', async (event: PluginEvent, tx: PluginTx) => {
    const workspaceId = (event as PluginEvent & { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceId !== 'string') return;
    const bots = await tx.query<{ bot_id: string }>(
      'SELECT m.bot_id FROM app.mcp_bot_tools m JOIN app.bots b ON b.id = m.bot_id WHERE b.workspace_id = $1::uuid',
      [workspaceId],
    );
    refreshAfterCommit(bots.rows.map((r) => r.bot_id));
  });
  // a new token was paired: nothing it has read is known yet, so the page must not claim the old token's list
  ctx.events.subscribe('bots.pairing.rotated', async (event: PluginEvent, tx: PluginTx) => {
    const botId = (event as PluginEvent & { botId?: unknown }).botId;
    if (typeof botId !== 'string') return;
    await tx.query('UPDATE app.mcp_bot_tools SET listed_digest = NULL, listed_at = NULL WHERE bot_id = $1::uuid', [botId]);
    // the old token no longer resolves: the streams held on it end at the next token check, so make that check now instead of at the next ten-second tick
    setTimeout(() => hub.wake({ tokens: true }), 100).unref();
  });
}

/**
 * gateway-mcp: the one MCP endpoint a bot's run calls its tools through (SPEC §11, PLAN P5-09). The runtime asks
 * for a run with the bot's pairing token and gets a URL and a token for that run alone; every call to it is
 * resolved back to the run, so a tool call can always be attributed — to the bot for what it may do, to the asking
 * person for what it may see — and every hit a read answers with lands in `run_source_log`. The tools are the
 * capabilities plugins registered, checked one by one by the kernel's broker; the JSON-RPC face is in
 * `src/protocol.ts` and the shapes on the wire are HTTP's (docs/plugins/gateway-mcp.md).
 *
 * A bot's own address also pushes: it hands out a session id, serves the `GET` event stream and sends
 * `notifications/tools/list_changed` when the tools digest of a bot changes (PLAN P14-22), so a Hermes profile that
 * lists tools once, when it is served, still sees a changed `BOT.md` at once.
 *
 * It declares no capability of its own any more: `knowledge.search`, its last stub, is the knowledge plugin's now, and the
 * `tasks.*` tools are the tasks plugin's. This catalog only describes them (PLAN P6-02, P8-08).
 */
export default definePlugin({
  manifest: {
    name: 'gateway-mcp',
    version: '0.1.0',
    kind: 'server',
    extends: ['tool.invoke', 'hook.pre_egress', 'event.emit', 'event.subscribe', 'provider.mcp.tools'],
    events: {
      emits: ['guardrails.dlp.decided'],
      consumes: ['bots.bot.loaded', 'guardrails.policy.updated', 'bots.pairing.rotated'],
    },
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
    const warn = (line: string): void => void process.stderr.write(`${line}\n`);
    const sessions = createMcpSessions(sessionSecretFromEnv(process.env, warn));
    const hub = createStreamHub({
      versions: (botIds) => ctx.db.system((tx) => readVersions(tx, botIds)),
      validTokens: (hashes) => ctx.db.system((tx) => stillValidTokens(tx, hashes)),
      warn,
    });
    registerMcpRoutes(ctx, { sessions, hub });
    watchToolChanges(ctx, hub);
    const provider: McpToolsProvider = {
      id: 'mcp.tools',
      toolsDigest: (botId) => ctx.db.system((tx) => currentToolsDigest(ctx, tx, botId)),
      offered: async (run) =>
        (await offeredTools(ctx, run)).map((o) => ({ name: o.descriptor.name, description: o.descriptor.description ?? '', inputSchema: o.descriptor.inputSchema as Record<string, unknown> })),
      call: async (run, name, args) => {
        const result = await callTool(ctx, run, { name, arguments: args });
        const text = result.content.map((c) => c.text).join('\n');
        return { text, isError: result.isError === true };
      },
      ...sandboxMembers(ctx),
    };
    ctx.providers.register('mcp.tools', provider);
  },
});
