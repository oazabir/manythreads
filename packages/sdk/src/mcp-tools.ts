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

  // The sandbox (PLAN P7-05, the Workshop's Rehearse mode). A plugin that is not a runtime cannot open a run (`capability.call` is not `tool.invoke`), and it must not be able to make a
  // rehearsal that is not one. So the broker offers a closed set of four members: a run that is ALWAYS a rehearsal, its tool list, one call through the hold, and its end. The hold is
  // enforced here, in the broker, never by what the model is told: `sandboxCall` re-reads the run's own row and refuses anything that is not a running rehearsal run, then holds back
  // EVERY tool that is not a read (the reply tool included), and logs the held call in `rehearsal_intercepts`.

  /** Opens a rehearsal run for `askerActorId` (a person on the bot's team) with the bot. The flag is set here, never by the caller. Throws when the bot or the asker does not qualify. */
  openSandbox(input: { workspaceId: string; teamId: string; botId: string; askerActorId: string }): Promise<BotRunHandle>;
  /** What the bot could call in the sandbox: its offered tools plus `test.write`, a write that exists only here and does nothing anywhere. */
  sandboxTools(run: BotRunHandle): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>;
  /** One call in the sandbox. `held` is true when the call was a write and the broker held it back (nothing was done). Throws `RunEndedError` for a run that has ended. */
  sandboxCall(run: BotRunHandle, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; held: boolean }>;
  /** Ends the sandbox run and revokes its token. */
  closeSandbox(run: BotRunHandle, status: 'done' | 'failed' | 'stopped'): Promise<void>;
}

/** The name of the write that exists only in the sandbox. A real bot cannot call it (nothing implements it outside `sandboxCall`). */
export const SANDBOX_TEST_WRITE = 'test.write';
