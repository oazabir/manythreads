import { HttpError, RunEndedError, type BotRunHandle, type HttpResponse, type PluginContext } from '@manythreads/sdk';
import {
  MCP_ERROR_CODES,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  McpError,
  McpInitializeResult,
  McpJsonRpcId,
  McpRequest,
  McpToolCallParams,
  McpToolDescriptor,
  McpToolResult,
  McpToolsListResult,
} from '@manythreads/shared';
import { z } from 'zod';
import { askForApproval } from './approval.ts';
import { authorizeContext, definitionOf, withRunTeam } from './catalog.ts';
import { json } from './http.ts';

// The JSON-RPC 2.0 face of the run endpoint (MCP revision 2024-11-05). Three methods matter — `initialize`,
// `tools/list` and `tools/call` — plus `ping` and the notifications a client sends and expects no answer to.
//
// Two rules the rest of the plugin depends on:
//   * a tool-level refusal (no grant, a missing argument, a handler's own `ok: false`) is an *answer*, carried as
//     `isError: true` content, so the model reads why and can try something else;
//   * only a transport fault (unparseable body, unknown method, wrong params shape) is a JSON-RPC error.

/** The envelope both answers use; exactly one of `result` / `error` is set. */
const McpEnvelope = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: McpJsonRpcId.nullable(),
    result: z.unknown().optional(),
    error: McpError.optional(),
  })
  .refine((e) => (e.result === undefined) !== (e.error === undefined), { message: 'exactly one of result and error' });

const reply = (id: McpRequest['id'] | null, result: unknown): HttpResponse =>
  json(McpEnvelope.parse({ jsonrpc: '2.0', id: id ?? null, result }));

const fail = (id: McpRequest['id'] | null, code: number, message: string, data?: unknown): HttpResponse =>
  json(McpEnvelope.parse({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }));

/** A handler's own `{ ok: false }` answer: the client must see it as a failed call (with the reason in the content), not a success. */
const isRefusal = (answer: unknown): boolean => typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === false;

/** One tool answer: the JSON of whatever the capability returned, in one text block. */
export function toolResult(answer: unknown, isError = false): McpToolResult {
  return McpToolResult.parse({
    content: [{ type: 'text', text: JSON.stringify(answer) }],
    ...(isError ? { isError: true } : {}),
  });
}

/** What `tools/list` offers this run: every implemented capability the broker would allow, and nothing else. */
async function listTools(ctx: PluginContext, run: BotRunHandle): Promise<McpToolDescriptor[]> {
  const offered: McpToolDescriptor[] = [];
  for (const tool of ctx.runs.catalog()) {
    // the run's token was resolved (it is `running`) a moment ago, in this request: no liveness read per capability
    const decision = await ctx.runs.may(run, tool.name, {}, { alreadyLive: true });
    if (!decision.allowed) continue;
    const definition = definitionOf(tool.name);
    offered.push(
      McpToolDescriptor.parse({
        name: tool.name,
        description: decision.needsApproval ? `${definition.description} Needs a person’s approval before it runs.` : definition.description,
        inputSchema: definition.inputSchema,
        destructive: tool.destructive,
      }),
    );
  }
  return offered;
}

/** Runs one `tools/call`, from the grant check to the source log. */
async function callTool(ctx: PluginContext, run: BotRunHandle, params: McpToolCallParams): Promise<McpToolResult> {
  const definition = definitionOf(params.name);
  const input = withRunTeam(params.name, params.arguments ?? {}, run.teamId);
  // A mutation is authorized against the path its input names: the broker's guard has to see the same path the
  // handler will write, and a call that names none is refused rather than judged blind.
  const decision = await ctx.runs.authorize(run, params.name, authorizeContext(input));
  if (!decision.allowed) return toolResult({ ok: false, code: 'forbidden', message: decision.reason }, true);
  const unknown = ctx.runs.catalog().some((t) => t.name === params.name);
  if (!unknown) {
    return toolResult({ ok: false, code: 'unknown_tool', message: `Nothing implements “${params.name}”.` }, true);
  }

  if (decision.needsApproval) {
    // The grant says a person must approve this call: it becomes a pending approval (the approvals plugin's one handler) and the model is
    // told. Without that plugin the call is refused outright — running it anyway is the one thing the flag exists to stop.
    return toolResult(await askForApproval(ctx, run, params.name, definition.kind, input), true);
  }

  if (definition.kind === 'stub') {
    return toolResult(definition.answer ?? { ok: false, code: 'not_available', message: 'Not available in this deployment yet.' });
  }
  if (definition.kind === 'read') {
    const answer = await ctx.runs.asReader(run, async (tx) => {
      const result = await ctx.runs.invoke(tx, params.name, input);
      // The source log is what "Sources reached" and the retention rule stand on: one line per hit the call answered with.
      for (const source of definition.sourcesFrom?.(result) ?? []) await ctx.runs.logSource(tx, source);
      return result;
    });
    return toolResult(answer);
  }
  try {
    const answer = await ctx.runs.asBot(run, (tx) => ctx.runs.invoke(tx, params.name, input));
    return toolResult(answer, isRefusal(answer));
  } catch (err) {
    // A run that ended under the call is control flow (the caller turns it into `run_ended` / 401), not a tool answer.
    if (err instanceof RunEndedError) throw err;
    return toolResult(thrownAnswer(params.name, err), true);
  }
}

/** Where the real text of an unexpected error goes (the server's stderr); tests replace it. The plugin SDK has no request logger. */
let faultLog: (line: string) => void = (line) => void process.stderr.write(`${line}\n`);
export function setFaultLog(fn: (line: string) => void): void {
  faultLog = fn;
}

/**
 * A handler that throws is still a tool answer, so the model reads why. Only the platform's own errors carry their sentence (an `HttpError`
 * keeps its code — `validation_failed`, `forbidden`, `not_found`, `conflict` — and message; a Zod failure is `validation_failed` naming the fields).
 * Anything else (a database error with column and constraint names, say) is logged here and the model gets a generic sentence.
 */
function thrownAnswer(tool: string, err: unknown): { ok: false; code: string; message: string } {
  if (err instanceof HttpError) return { ok: false, code: err.code, message: err.message.slice(0, 300) };
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => `${i.path.map(String).join('.') || '(input)'}: ${i.message}`).join('; ');
    return { ok: false, code: 'validation_failed', message: issues.slice(0, 300) };
  }
  faultLog(`gateway-mcp: tool call ${tool} threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
  return { ok: false, code: 'failed', message: 'the call failed' };
}

/**
 * Handles one JSON-RPC request for `run`. A notification (no `id`) is answered with 202 and no body, as the MCP
 * client expects; everything else comes back as an envelope with the caller's own id.
 */
export async function handleRpc(ctx: PluginContext, run: BotRunHandle, raw: unknown): Promise<HttpResponse> {
  try {
    return await handleRpcInner(ctx, run, raw);
  } catch (err) {
    // The run was ended between resolving its token and acting for it (a close, the reaper, an approval's re-run): the client is told so, in
    // the shape it already handles — a tool answer for a call, a 401 for anything else — never a 500.
    if (!(err instanceof RunEndedError)) throw err;
    const request = McpRequest.safeParse(raw);
    if (request.success && request.data.method === 'tools/call') {
      return reply(request.data.id, toolResult({ ok: false, code: 'run_ended', message: 'This run has ended; open a new one.' }, true));
    }
    throw new HttpError(401, 'unauthenticated', 'This run has ended');
  }
}

async function handleRpcInner(ctx: PluginContext, run: BotRunHandle, raw: unknown): Promise<HttpResponse> {
  const parsed = McpRequest.safeParse(raw);
  if (!parsed.success) return fail(null, MCP_ERROR_CODES.invalidRequest, 'A JSON-RPC 2.0 request is required');
  const request = parsed.data;

  if (request.method.startsWith('notifications/')) return { status: 202 };

  switch (request.method) {
    case 'initialize':
      return reply(
        request.id,
        McpInitializeResult.parse({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: ctx.manifest.version },
        }),
      );
    case 'ping':
      return reply(request.id, {});
    case 'tools/list':
      return reply(request.id, McpToolsListResult.parse({ tools: await listTools(ctx, run) }));
    case 'tools/call': {
      const params = McpToolCallParams.safeParse(request.params);
      if (!params.success) {
        return fail(request.id, MCP_ERROR_CODES.invalidParams, 'tools/call needs a tool name and object arguments', {
          issues: params.error.issues.map((i) => `${i.path.map(String).join('.') || '(params)'}: ${i.message}`),
        });
      }
      return reply(request.id, await callTool(ctx, run, params.data));
    }
    default:
      return fail(request.id, MCP_ERROR_CODES.methodNotFound, `Unknown method “${request.method}”`);
  }
}

/** The bot behind a presented bot token (`app.bots_pairing_resolve`): enough to list tools when no run is open. */
export interface PairedBotHandle {
  botId: string;
  botActorId: string;
  teamId: string;
  workspaceId: string;
}

/** What a bot's tool list is judged against when no run is open: the widest trigger, so a client that lists once, at connect, sees every tool the bot can ever be offered. */
const LISTING_TRIGGER = 'conversation';
const NO_RUN_ID = '00000000-0000-0000-0000-000000000000';

/**
 * One JSON-RPC request at the bot's stable endpoint. The caller is a gateway profile that holds ONE address and ONE token for the bot (it cannot
 * be given a new token per run), so the run is looked up here: the bot's currently open run, which the runtime guarantees is at most one. A tool
 * call is attributed to that run exactly as a call at the run's own endpoint is — the same `handleRpc`, so reads are the asker's, writes the
 * bot's, approvals and the source log are the run's. With no run open, a call is answered with a clear tool error and the protocol's own
 * methods (`initialize`, `ping`, `tools/list`) still work, because a client connects and lists before any conversation exists.
 */
export async function handleBotRpc(ctx: PluginContext, bot: PairedBotHandle, run: BotRunHandle | 'ambiguous' | null, raw: unknown): Promise<HttpResponse> {
  if (run !== null && run !== 'ambiguous') return handleRpc(ctx, run, raw);
  if (run === 'ambiguous') {
    // More than one run of this bot is open: attributing a call to either could be wrong, so no call is made (fail closed).
    const request = McpRequest.safeParse(raw);
    if (request.success && request.data.method === 'tools/call') {
      return reply(request.data.id, toolResult({ ok: false, code: 'ambiguous_run', message: 'More than one conversation is open for this bot, so the call cannot be attributed. Try again shortly.' }, true));
    }
  }
  const request = McpRequest.safeParse(raw);
  if (request.success && request.data.method === 'tools/call') {
    return reply(
      request.data.id,
      toolResult({ ok: false, code: 'no_open_run', message: 'No conversation is waiting for this bot, so there is nothing to act for. Tools work only while the bot is answering a message.' }, true),
    );
  }
  const listing: BotRunHandle = {
    runId: NO_RUN_ID,
    botId: bot.botId,
    botActorId: bot.botActorId,
    teamId: bot.teamId,
    workspaceId: bot.workspaceId,
    trigger: LISTING_TRIGGER,
    askerActorId: null,
    expiresAt: new Date(0).toISOString(),
  };
  return handleRpc(ctx, listing, raw);
}
