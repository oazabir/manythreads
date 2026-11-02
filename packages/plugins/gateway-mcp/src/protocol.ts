import { HttpError, RunEndedError, type BotRunHandle, type HttpResponse, type PluginContext, type ToolApprovalCard } from '@manythreads/sdk';
import {
  MCP_ERROR_CODES,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SESSION_HEADER,
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
import { authorizeContext, definitionOf, interceptTarget, withRunTeam, type ToolDefinition } from './catalog.ts';
import { describeFinding, guardValue } from './guard.ts';
import { toolsDigest, type OfferedTool } from './digest.ts';
import { json } from './http.ts';
import type { McpSessions } from './session.ts';

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

/**
 * How a tool is described and how a call to it behaves: the descriptor of the source that owns it (a connection's tool, `ctx.toolSources`), else the catalog's
 * own entry. A source's tool is never a `stub` and never rehearsal-safe: it is a read or a write, and a write is held back in a rehearsal.
 */
function describeTool(ctx: PluginContext, name: string): ToolDefinition {
  const found = ctx.toolSources.find(name);
  if (!found) return definitionOf(name);
  const { tool } = found;
  return { name, description: tool.description, inputSchema: tool.inputSchema, kind: tool.kind, ...(tool.sourcesFrom ? { sourcesFrom: tool.sourcesFrom } : {}) };
}

/**
 * Of the tools of each source, the ones the source itself would offer the run's bot (a grant from a connection that is on and has not expired). Asked once per source
 * per listing, in a transaction as the bot, so what the bot may not see is not offered. A source that throws offers nothing: the listing fails closed.
 */
async function offeredBySources(ctx: PluginContext, run: BotRunHandle): Promise<Map<string, ReadonlySet<string>>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const source of ctx.toolSources.list()) {
    try {
      const names = await ctx.db.as({ actorId: run.botActorId, kind: 'bot', workspaceId: run.workspaceId, personId: null, sessionId: null }, (tx) => source.offered(tx, run));
      const own = new Set(source.tools.map((t) => t.name));
      out.set(source.id, new Set(names.filter((n) => own.has(n))));
    } catch (err) {
      faultLog(`gateway-mcp: tool source ${source.id} could not list its tools: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
      out.set(source.id, new Set());
    }
  }
  return out;
}

/**
 * What `tools/list` offers this run: every implemented capability the broker would allow, and nothing else. `needsApproval` is kept beside each
 * descriptor (the wire carries it only inside the description) because the tools digest is decided by it.
 */
export async function offeredTools(ctx: PluginContext, run: BotRunHandle): Promise<OfferedTool[]> {
  const offered: OfferedTool[] = [];
  const fromSources = await offeredBySources(ctx, run);
  for (const tool of ctx.runs.catalog()) {
    // a tool of a source needs the source's yes as well as the broker's: both must agree (a source is asked first, it is the cheaper "no")
    const owner = ctx.toolSources.find(tool.name);
    if (owner && !fromSources.get(owner.source.id)?.has(tool.name)) continue;
    // the run's token was resolved (it is `running`) a moment ago, in this request: no liveness read per capability
    const decision = await ctx.runs.may(run, tool.name, {}, { alreadyLive: true });
    if (!decision.allowed) continue;
    const definition = describeTool(ctx, tool.name);
    offered.push({
      descriptor: McpToolDescriptor.parse({
        name: tool.name,
        description: decision.needsApproval ? `${definition.description} Needs a person’s approval before it runs.` : definition.description,
        inputSchema: definition.inputSchema,
        destructive: tool.destructive,
      }),
      needsApproval: decision.needsApproval,
    });
  }
  return offered;
}

const listTools = async (ctx: PluginContext, run: BotRunHandle): Promise<McpToolDescriptor[]> => (await offeredTools(ctx, run)).map((o) => o.descriptor);

/**
 * The data-loss check, failing closed: if reading the value throws (the policy tables are missing, the database is down), the value counts as unread and
 * the caller refuses it, rather than the check turning into an error page or, worse, being skipped. A run that ended under the check is control flow.
 */
async function guarded(ctx: PluginContext, run: BotRunHandle, value: unknown, where: 'mcp' | 'mcp_result'): ReturnType<typeof guardValue> {
  try {
    return await guardValue(ctx, run, value, where);
  } catch (err) {
    if (err instanceof RunEndedError) throw err;
    faultLog(`gateway-mcp: the data-loss check threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
    return { outcome: 'block', value, rules: [], unchecked: true };
  }
}

/** The results `holdBack` made: the one sure sign that a call was held back (an answer's own text can say anything, this set cannot be written to from outside). */
const heldResults = new WeakSet<McpToolResult>();
export const wasHeld = (result: McpToolResult): boolean => heldResults.has(result);

/**
 * Runs one `tools/call`, from the grant check to the source log. `sandbox` is the Workshop's Rehearse mode (`sandbox.ts`): the run is a rehearsal and NOTHING that is not a read goes
 * through, the reply tool included (a Workshop rehearsal has no conversation thread to post into), and a read that would wait for a person is held too, because a rehearsal files no card.
 */
export async function callTool(ctx: PluginContext, run: BotRunHandle, params: McpToolCallParams, options: { sandbox?: boolean } = {}): Promise<McpToolResult> {
  const definition = describeTool(ctx, params.name);
  let input = withRunTeam(params.name, params.arguments ?? {}, run.teamId);
  // A mutation is authorized against the path its input names: the broker's guard has to see the same path the
  // handler will write, and a call that names none is refused rather than judged blind.
  const authContext = authorizeContext(input);
  const decision = await ctx.runs.authorize(run, params.name, authContext);
  // What the door decided is kept (content-blind: the tool, where it aimed, the broker's own reason) so the Workshop can replay it against the grants of the day. The paths are what
  // the broker judged (a place in the team's files, never what would be written there), so the replay asks it about the same places.
  const places = decisionPlaces(params.name, definition.kind, input, authContext);
  await recordDecision(ctx, run, {
    kind: 'tool',
    subject: params.name,
    outcome: !decision.allowed ? 'denied' : decision.needsApproval ? 'needs_approval' : 'allowed',
    target: places.target,
    messageId: null,
    detail: {
      reason: decision.reason.slice(0, 300),
      tool: definition.kind,
      ...(places.path !== undefined ? { path: places.path } : {}),
      ...(places.paths !== undefined ? { paths: places.paths } : {}),
      // some place the call named was left out of the record (too many, too long, or not shaped like a path of the team's files): the replay then does not judge this line
      ...(places.truncated ? { truncated: true } : {}),
    },
  });
  if (!decision.allowed) return toolResult({ ok: false, code: 'forbidden', message: decision.reason }, true);
  const unknown = ctx.runs.catalog().some((t) => t.name === params.name);
  if (!unknown) {
    return toolResult({ ok: false, code: 'unknown_tool', message: `Nothing implements “${params.name}”.` }, true);
  }

  // The data-loss check (PLAN P10-04): what the call carries out is read before anything runs. A stub sends nothing anywhere, so it is not read.
  let holdForPerson = false;
  if (definition.kind !== 'stub') {
    const checked = await guarded(ctx, run, input, 'mcp');
    if (checked.rules.length > 0 || checked.outcome !== 'allow') {
      await recordDecision(ctx, run, {
        kind: 'guard',
        subject: 'mcp',
        outcome: checked.unchecked ? 'block' : checked.outcome,
        target: null,
        messageId: null,
        detail: { tool: params.name, rules: checked.rules.slice(0, 20), unchecked: checked.unchecked === true },
      });
    }
    if (checked.unchecked) {
      return toolResult({ ok: false, code: 'blocked_by_guardrail', message: 'This call was not made: the data-loss check could not read it (too large, too deeply nested, or the check is not working).' }, true);
    }
    if (checked.outcome === 'block') {
      return toolResult({ ok: false, code: 'blocked_by_guardrail', message: `This call was not made: it carries ${describeFinding(checked.rules)}. Take it out and try again.` }, true);
    }
    if (checked.outcome === 'redact' || checked.outcome === 'require_approval') input = checked.value as Record<string, unknown>;
    holdForPerson = checked.outcome === 'require_approval';
    if (holdForPerson && definition.kind === 'read') {
      return toolResult({ ok: false, code: 'blocked_by_guardrail', message: `This call was not made: it carries ${describeFinding(checked.rules)}, and a read cannot wait for a person.` }, true);
    }
  }

  // A rehearsal (the bot page's Test action) makes no change: a write is held back HERE, at the one door every tool call passes, after the grant and the
  // data-loss check have judged it (a call the bot could not make is still refused for the real reason) and before anything that has an effect — the
  // approval inbox included, so a rehearsal never leaves a card for a person. The run's own row says it is a rehearsal (resolved from the token, never
  // from the request). A tool that is not a known read, and not the reply itself, counts as a write, so a tool added later is held back until someone says otherwise.
  // The reply itself (`rehearsalSafe`) goes through only when it would go straight out: a reply that would wait for a person would file a card in the
  // Approvals inbox, so it is held back like any write (the closing text of the run then carries the answer).
  // A source may hold a write for a person whatever the grant says (the mail tools do inside a mail thread); the card it returns says where the call really goes.
  let sourceCard: ToolApprovalCard | null = null;
  if (definition.kind === 'write') {
    const owner = ctx.toolSources.find(params.name)?.source;
    if (owner?.approval) {
      try {
        sourceCard = await ctx.runs.asBot(run, (tx) => owner.approval!(tx, run, params.name, input));
      } catch (err) {
        if (err instanceof RunEndedError) throw err;
        faultLog(`gateway-mcp: the approval check of “${params.name}” threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
        sourceCard = { summary: params.name, preview: {} }; // fail closed: a source that cannot say waits for a person
      }
    }
  }
  const waitsForPerson = decision.needsApproval || holdForPerson || sourceCard !== null;

  if (
    run.rehearsal === true &&
    ((definition.kind !== 'read' && definition.kind !== 'stub' && (options.sandbox === true || definition.rehearsalSafe !== true || waitsForPerson)) ||
      // a read or a stub that the grant says a person must approve would file a card in the Approvals inbox: a rehearsal files none
      ((definition.kind === 'read' || definition.kind === 'stub') && waitsForPerson))
  ) {
    return await holdBack(ctx, run, params.name, input, waitsForPerson);
  }

  if (waitsForPerson) {
    // The grant (or the source) says a person must approve this call: it becomes a pending approval (the approvals plugin's one handler) and the model is
    // told. Without that plugin the call is refused outright — running it anyway is the one thing the flag exists to stop.
    return toolResult(await askForApproval(ctx, run, params.name, definition.kind, input, sourceCard ?? undefined), true);
  }

  if (definition.kind === 'stub') {
    return toolResult(definition.answer ?? { ok: false, code: 'not_available', message: 'Not available in this deployment yet.' });
  }
  if (definition.kind === 'read') {
    let answer: unknown;
    try {
      answer = await ctx.runs.asReader(run, async (tx) => {
        const result = await ctx.runs.invoke(tx, params.name, input);
        // The source log is what "Sources reached" and the retention rule stand on: one line per hit the call answered with.
        for (const source of definition.sourcesFrom?.(result) ?? []) await ctx.runs.logSource(tx, source);
        // A read of a tool source always leaves a line, whatever `sourcesFrom` answered (a source may name no hit, or none at all): the retention rule ("a run keeps
        // no wider than the narrowest source it read") must see that outside data was read. The gateway cannot tell how widely the data is visible, so the line
        // takes the narrowest scope.
        if (ctx.toolSources.find(params.name)) await ctx.runs.logSource(tx, { sourceType: 'connection', sourceRef: params.name, scope: 'person' });
        return result;
      });
    } catch (err) {
      // A run that ended under the call is control flow; a refusal of the tool's own (a source's `forbidden`) is an answer the model reads.
      if (err instanceof RunEndedError) throw err;
      return toolResult(thrownAnswer(params.name, err), true);
    }
    // What a read answers with is checked before the bot sees it: a secret that sits in a page or a file stays out of the model's context.
    const shown = await guarded(ctx, run, answer, 'mcp_result');
    if (shown.unchecked || shown.outcome === 'block' || shown.outcome === 'require_approval') {
      return toolResult({ ok: false, code: 'withheld_by_guardrail', message: `The answer was held back: it carries ${describeFinding(shown.rules)}, which the data-loss policy does not let through.` }, true);
    }
    return toolResult(shown.outcome === 'redact' ? shown.value : answer);
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

/** How many decision lines this process could not keep (it is logged each time too). A line that is lost leaves a hole in a later replay, so the number is exposed. */
let lostDecisions = 0;
export const lostDecisionCount = (): number => lostDecisions;

// ---- what a decision line may say about WHERE a call aimed -----------------------------------------------------------------------------------------------------------------------
// A decision line is content-blind. A path or an id in a tool's arguments is written by the model, so it can hold anything (a secret it was shown, a sentence). A place is kept
// only when it has the shape of one: a path of the team's files (a known first folder, plain characters, no long opaque string) or an id / slug of the platform.
const REPO_ROOTS = new Set(['TEAM.md', 'apps', 'bots', 'knowledge', 'memory', 'pages', 'routines', 'skills']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OPAQUE_RUN = /[A-Za-z0-9]{24,}/;
const PLACE_PATH_MAX = 200;
const PLACE_PATHS_MAX = 5;

/** The path as it may be kept, or null when it is not shaped like a path of the team's files. */
export function keepablePath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > PLACE_PATH_MAX) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.includes('//')) return null;
  const segments = value.split('/');
  if (!REPO_ROOTS.has(segments[0] as string)) return null;
  return segments.some((seg) => OPAQUE_RUN.test(seg)) ? null : value;
}

/** What a tool call aimed at, in the form a decision line may carry. */
export function decisionPlaces(
  tool: string,
  kind: string,
  input: Record<string, unknown>,
  context: { path?: string; paths?: readonly string[] },
): { target: string | null; path?: string; paths?: string[]; truncated: boolean } {
  // only a change to the team's files is judged by place (the broker asks for the path of a files.* or pages.* mutation)
  const byPlace = kind !== 'read' && (tool.startsWith('files.') || tool.startsWith('pages.'));
  let truncated = false;
  let path: string | undefined;
  let paths: string[] | undefined;
  if (byPlace && context.path !== undefined) {
    const kept = keepablePath(context.path);
    if (kept === null) truncated = true;
    else path = kept;
  }
  if (byPlace && context.paths !== undefined) {
    if (context.paths.length > PLACE_PATHS_MAX) truncated = true;
    const kept = context.paths.slice(0, PLACE_PATHS_MAX).flatMap((p) => {
      const k = keepablePath(p);
      if (k === null) truncated = true;
      return k === null ? [] : [k];
    });
    paths = kept;
  }
  // the one place shown on the Test page's list of held steps: a path, or an id / slug the platform itself would have issued
  let target: string | null = path ?? paths?.[0] ?? null;
  if (target === null) {
    for (const key of ['channelId', 'taskId', 'messageId'] as const) {
      const value = input[key];
      if (typeof value === 'string' && UUID.test(value)) {
        target = value;
        break;
      }
    }
  }
  if (target === null) {
    for (const key of ['toBotSlug', 'team'] as const) {
      const value = input[key];
      if (typeof value === 'string' && SLUG.test(value) && !OPAQUE_RUN.test(value)) {
        target = value;
        break;
      }
    }
  }
  return { target, ...(path !== undefined ? { path } : {}), ...(paths !== undefined ? { paths } : {}), truncated };
}

/**
 * Keeps one line of what the gate, guard or tool door decided (`run_decisions`). Recording is never allowed to change the outcome of the call it describes: a failure is
 * logged and the call goes on. A run that ended under it is control flow, as everywhere in this file.
 */
async function recordDecision(ctx: PluginContext, run: BotRunHandle, decision: Parameters<PluginContext['runs']['logDecision']>[1]): Promise<void> {
  try {
    await ctx.runs.asBot(run, (tx) => ctx.runs.logDecision(tx, decision));
  } catch (err) {
    if (err instanceof RunEndedError) throw err;
    lostDecisions += 1;
    faultLog(`gateway-mcp: a decision of ${decision.subject} could not be recorded: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
  }
}

/**
 * A write a rehearsal run tried: nothing is done, one line is kept (the tool and where it aimed, no content), and the model is told in so many words that
 * nothing happened so it does not report the work as finished. The answer is `ok: true` so the model carries on to its reply instead of retrying.
 */
export async function holdBack(ctx: PluginContext, run: BotRunHandle, tool: string, input: Record<string, unknown>, wouldWait: boolean): Promise<McpToolResult> {
  const target = interceptTarget(input);
  try {
    await ctx.runs.asBot(run, (tx) => ctx.runs.logIntercept(tx, { capability: tool, target, wouldWait }));
  } catch (err) {
    if (err instanceof RunEndedError) throw err;
    // The line could not be kept, so the page could not list the call: the call is still not made, and the model is told it failed rather than that it was held.
    faultLog(`gateway-mcp: a rehearsal could not record a held-back ${tool}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
    return toolResult({ ok: false, code: 'failed', message: 'the call was not made' }, true);
  }
  const held = toolResult({
    ok: true,
    rehearsal: true,
    done: false,
    message: `Rehearsal: “${tool}” was NOT done. Nothing changed and nothing was sent. In your reply say what you would have done, and do not say it happened.`,
  });
  heldResults.add(held);
  return held;
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

/** The handle a bot is judged by when no run is open. The tools digest is the digest of this list, whichever run is open when a client lists. */
export function listingHandleOf(bot: PairedBotHandle): BotRunHandle {
  return {
    runId: NO_RUN_ID,
    botId: bot.botId,
    botActorId: bot.botActorId,
    teamId: bot.teamId,
    workspaceId: bot.workspaceId,
    trigger: LISTING_TRIGGER,
    askerActorId: null,
    expiresAt: new Date(0).toISOString(),
  };
}

/** What a bot's endpoint adds to the protocol: the session ids it hands out, and the word that a token has read its tools. */
export interface BotEndpoint {
  sessions: McpSessions;
  /** Called after a `tools/list` at the bot's endpoint with the digest of the bot's current list. Not awaited; must not throw. */
  listed(botId: string, digest: string): void;
}

/**
 * One JSON-RPC request at the bot's stable endpoint. The caller is a gateway profile that holds ONE address and ONE token for the bot (it cannot
 * be given a new token per run), so the run is looked up here: the bot's currently open run, which the runtime guarantees is at most one. A tool
 * call is attributed to that run exactly as a call at the run's own endpoint is — the same `handleRpc`, so reads are the asker's, writes the
 * bot's, approvals and the source log are the run's. With no run open, a call is answered with a clear tool error and the protocol's own
 * methods (`initialize`, `ping`, `tools/list`) still work, because a client connects and lists before any conversation exists.
 *
 * With an `endpoint`, `initialize` says the list can change and carries a session id (`Mcp-Session-Id`), because this address also serves the `GET`
 * event stream that pushes `notifications/tools/list_changed`; a run's own address does neither.
 */
export async function handleBotRpc(
  ctx: PluginContext,
  bot: PairedBotHandle,
  run: BotRunHandle | 'ambiguous' | null,
  raw: unknown,
  endpoint?: BotEndpoint,
): Promise<HttpResponse> {
  const request = McpRequest.safeParse(raw);
  const method = request.success ? request.data.method : null;
  if (endpoint && request.success && method === 'initialize') {
    const answer = reply(
      request.data.id,
      McpInitializeResult.parse({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: MCP_SERVER_NAME, version: ctx.manifest.version },
      }),
    );
    return { ...answer, headers: { [MCP_SESSION_HEADER]: endpoint.sessions.issue(bot.botId) } };
  }
  if (run !== null && run !== 'ambiguous') {
    const answer = await handleRpc(ctx, run, raw);
    if (endpoint && method === 'tools/list') {
      // the answer above is judged by the open run's trigger; the page compares the bot's own list, so that one is read here
      void offeredTools(ctx, listingHandleOf(bot)).then(
        (offered) => endpoint.listed(bot.botId, toolsDigest(offered)),
        () => undefined,
      );
    }
    return answer;
  }
  if (request.success && method === 'tools/call') {
    // More than one run of this bot open: attributing a call to either could be wrong, so no call is made (fail closed). With none open, nothing waits for the bot.
    return reply(
      request.data.id,
      run === 'ambiguous'
        ? toolResult({ ok: false, code: 'ambiguous_run', message: 'More than one conversation is open for this bot, so the call cannot be attributed. Try again shortly.' }, true)
        : toolResult({ ok: false, code: 'no_open_run', message: 'No conversation is waiting for this bot, so there is nothing to act for. Tools work only while the bot is answering a message.' }, true),
    );
  }
  const listing = listingHandleOf(bot);
  if (endpoint && request.success && method === 'tools/list') {
    const offered = await offeredTools(ctx, listing);
    endpoint.listed(bot.botId, toolsDigest(offered));
    return reply(request.data.id, McpToolsListResult.parse({ tools: offered.map((o) => o.descriptor) }));
  }
  return handleRpc(ctx, listing, raw);
}
