import type { BotRunHandle, HttpResponse, PluginContext } from '@manythreads/sdk';
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
    const decision = await ctx.runs.may(run, tool.name);
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
  const answer = await ctx.runs.asBot(run, (tx) => ctx.runs.invoke(tx, params.name, input));
  return toolResult(answer);
}

/**
 * Handles one JSON-RPC request for `run`. A notification (no `id`) is answered with 202 and no body, as the MCP
 * client expects; everything else comes back as an envelope with the caller's own id.
 */
export async function handleRpc(ctx: PluginContext, run: BotRunHandle, raw: unknown): Promise<HttpResponse> {
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
