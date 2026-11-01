import type { ProviderImpl } from './types.ts';

// What a bot's MCP tool list is right now, as one digest (P14-22), registered by gateway-mcp (`provider.mcp.tools`): `ctx.providers.get<McpToolsProvider>('mcp.tools')`.
// The digest covers exactly what `tools/list` answers the bot (names, descriptions, input schemas, whether each needs approval), so anything that
// changes the list — the bot's grants, an approval flag, a new version of the platform adding a tool — changes it. runtime-hermes writes it into the
// managed pod's profile so the pod re-serves a profile whose Hermes cannot be told by push. Look it up when you need it, not in `register`.

export interface McpToolsProvider extends ProviderImpl {
  id: 'mcp.tools';
  /** Sixty-four hex characters for the bot's current list, or null for a bot that does not exist. Runs as the system role. */
  toolsDigest(botId: string): Promise<string | null>;
}
