import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotId, RunId } from '../ids.ts';

// The MCP gateway (SPEC §11, PLAN P5-09). One endpoint per run: `runtime-hermes` launches one Hermes
// invocation per conversation run against a URL it was handed, so a tool call can always be resolved back to
// the run, the bot and the person who asked (the decision in `docs/spikes/per-run-scoping.md`). These are the
// shapes on that wire: JSON-RPC 2.0 requests and answers, and the mint the runtime calls to open a run.

/** The MCP revision this endpoint speaks (the one the Hermes MCP client sends). */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'manythreads';
/** How long a run's endpoint stays usable when the mint does not say (seconds). */
export const MCP_RUN_TTL_SECONDS = 900;
export const MCP_RUN_TTL_MAX_SECONDS = 3600;

/** A JSON-RPC id: what the caller chose, echoed back. Absent on a notification (no answer is sent). */
export const McpJsonRpcId = z.union([z.string().max(64), z.number().int()]);
export type McpJsonRpcId = z.infer<typeof McpJsonRpcId>;

/** One JSON-RPC 2.0 request. `params` is open: each method parses what it needs. */
export const McpRequest = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: McpJsonRpcId.optional(),
  method: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type McpRequest = z.infer<typeof McpRequest>;

/** JSON-RPC's own codes; the gateway adds `-32002` (unknown method) and `-32602` (bad params). */
export const MCP_ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export const McpError = z.strictObject({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type McpError = z.infer<typeof McpError>;

/** `initialize`: what the server is and what it can do. Only tools are offered. */
export const McpServerInfo = z.strictObject({ name: z.string(), version: z.string() });
export const McpInitializeResult = z.strictObject({
  protocolVersion: z.string(),
  capabilities: z.strictObject({ tools: z.strictObject({ listChanged: z.literal(false) }) }),
  serverInfo: McpServerInfo,
});
export type McpInitializeResult = z.infer<typeof McpInitializeResult>;

/** One tool as `tools/list` describes it. `inputSchema` is JSON Schema, never code. */
export const McpToolDescriptor = z.strictObject({
  /** The capability name itself (`messages.search`, `pages.write`): one vocabulary for the broker, the
   *  BOT.md allowlist and the model, so a tool a bot may not call cannot be named into existence. */
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** True when the tool writes; the runtime may show it differently (the broker decides regardless). */
  destructive: z.boolean().default(false),
});
export type McpToolDescriptor = z.infer<typeof McpToolDescriptor>;

export const McpToolsListResult = z.strictObject({ tools: z.array(McpToolDescriptor) });
export type McpToolsListResult = z.infer<typeof McpToolsListResult>;

/** `tools/call` content. Text only for now; a tool answers JSON in one text block. */
export const McpTextContent = z.strictObject({ type: z.literal('text'), text: z.string() });
export const McpToolResult = z.strictObject({
  content: z.array(McpTextContent),
  /** A refusal the model should read and act on (denied capability, missing argument) — not a transport error. */
  isError: z.boolean().optional(),
});
export type McpToolResult = z.infer<typeof McpToolResult>;

/**
 * `tools/call` params. `arguments` are the tool's own input, validated by the handler that owns the capability. `_meta` is MCP's
 * own reserved field on every params object (progress tokens, tracing) and is not a tool argument: a client that sends it —
 * Hermes' does, as `_meta: {}` on every call — must not be refused for it (the refusal read "tools/call needs a tool name and
 * object arguments", and the agent gave up on the tools). It is accepted and ignored.
 */
export const McpToolCallParams = z.strictObject({
  name: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type McpToolCallParams = z.infer<typeof McpToolCallParams>;

/**
 * What a runtime posts to open a run: the bot's pairing token (the only credential it holds, SPEC §7.6) and nothing that
 * names a person. A pairing token proves the caller is this bot's runtime, not that anyone asked the bot anything, so the
 * mint takes no asker and no trigger: the run it opens has no asker and the fixed trigger `webhook` (its reads see what the
 * bot itself sees, and `person:*` is never offered). Conversation and mention runs are opened in-process by the router,
 * which reads the asker from the message it answers. Strict: a client that sends `askerActorId` or `trigger` is refused.
 */
export const McpRunMintRequest = z.strictObject({
  pairingToken: z.string().min(1).max(500),
  /** The thread the run answers in, when it already has one. */
  threadId: z.uuid().optional(),
  ttlSeconds: z.number().int().min(30).max(MCP_RUN_TTL_MAX_SECONDS).default(MCP_RUN_TTL_SECONDS),
});
export type McpRunMintRequest = z.infer<typeof McpRunMintRequest>;

/**
 * The mint's answer: where the run's endpoint is and the one credential for it. `token` is shown once (the
 * database keeps its sha256); the runtime sends it as `Authorization: Bearer <token>`. `url` names the run and carries no
 * credential, so it can be logged.
 */
export const McpRunMintResponse = z.strictObject({
  runId: RunId,
  botId: BotId,
  url: z.string().min(1),
  token: z.string().min(1),
  expiresAt: IsoDateTime,
});
export type McpRunMintResponse = z.infer<typeof McpRunMintResponse>;

/**
 * The one MCP address every bot calls, on the install's public host: `https://<domain>/mcp`. The bearer token alone says who is calling (a
 * bot's pairing token or one run's token), so a gateway is configured with the same URL for every bot and the install needs no per-bot or
 * per-team host name. The older paths (`/api/mcp/bots/<botId>`, `/api/mcp/runs/<runId>`) keep working.
 */
export const MCP_PATH = '/mcp';
export const mcpUrlOf = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}${MCP_PATH}`;

/** How a run ended, as the runtime reports it. */
export const McpRunCloseRequest = z.strictObject({ status: z.enum(['done', 'failed', 'stopped']) });
export type McpRunCloseRequest = z.infer<typeof McpRunCloseRequest>;

/** What one tool call looks like in the run's source log (PLAN P5-09: every read is written down). */
export const McpRunSource = z.strictObject({
  sourceType: z.string().min(1),
  sourceRef: z.string().min(1),
  scope: z.enum(['team', 'channel', 'person']),
});
export type McpRunSource = z.infer<typeof McpRunSource>;
