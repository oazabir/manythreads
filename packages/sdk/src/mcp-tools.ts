import type { BotRunHandle, ProviderImpl } from './types.ts';

// What a bot's MCP tool list is right now, as one digest (P14-22), registered by gateway-mcp (`provider.mcp.tools`): `ctx.providers.get<McpToolsProvider>('mcp.tools')`.
// The digest covers exactly what `tools/list` answers the bot (names, descriptions, input schemas, whether each needs approval), so anything that
// changes the list — the bot's grants, an approval flag, a new version of the platform adding a tool — changes it. runtime-hermes writes it into the
// managed pod's profile so the pod re-serves a profile whose Hermes cannot be told by push. Look it up when you need it, not in `register`.

export interface McpToolsProvider extends ProviderImpl {
  id: 'mcp.tools';
  /** Sixty-four hex characters for the bot's current list, or null for a bot that does not exist. Runs as the system role. */
  toolsDigest(botId: string): Promise<string | null>;
  /**
   * The tools the broker would offer `run` right now: the same list `tools/list` answers over HTTP. For a runtime that calls tools itself instead of handing a model the MCP
   * address (the `model` runtime, P19-10). `run` is a run that is open.
   */
  offered(run: BotRunHandle): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>;
  /**
   * One tool call for `run` through the same door `tools/call` uses: the grant check, approvals, the data-loss check, a rehearsal's hold and the source log all apply. Answers the text a
   * model should read and whether it is an error. A run that has ended throws (`RunEndedError`).
   */
  call(run: BotRunHandle, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}
