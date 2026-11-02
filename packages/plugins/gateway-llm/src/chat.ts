import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { LlmAliasName } from '@manythreads/shared';
import { ALL_ALIASES } from './config.ts';
import { gatewayFromEnv } from './gateway.ts';
import { scrubProxyDetail, type LiteLlmChatMessage, type LlmGateway } from './litellm.ts';
import { loadEgress, preflight, recordSpend, type LlmCallDecision, type RateHit } from './limits.ts';

// One turn of a bot's run on an LLM gateway runner (the `model` runtime, P19-10): the bot's conversation so far and its tools go to the alias the runner names. It goes through the
// same door as every other model call: the pre-call check first on every user and tool message added since the last turn (the preset's egress rule, the guardrails and redaction, the
// budgets and, on the run's first turn, the bot's per-minute rate limit), then the proxy with the master key (the call is the platform's, made on the bot's behalf and tagged with the bot
// and the run), then a line in the spend ledger under the bot and the run. No database transaction is open while the proxy is being called. Like `classify` it answers and never throws for an unavailable model; the caller decides what that means for the run.

export interface LlmChatRequest {
  workspaceId: string;
  /** The bot the call is made for. Null for a call no bot makes: the "Add a bot" helper (PLAN P7-02) works before the bot exists, and its spend is under the team and its session. */
  botId: string | null;
  teamId: string;
  /** The run this turn belongs to: the ledger attributes the call to it. Null with `sessionId` for a call outside a run. */
  runId: string | null;
  /** What groups the calls in the ledger when there is no run (a setup session's id). A run's calls are grouped by `runId`. */
  sessionId?: string;
  /** What the call is for, as the proxy records it. `run` unless the caller says otherwise. */
  purpose?: 'run' | 'setup';
  /** The alias the runner names. */
  alias: string;
  messages: LiteLlmChatMessage[];
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  maxTokens: number;
  /** The run's first turn is one request against the bot's per-minute limit; later turns are not (budgets still count every token). */
  firstTurn: boolean;
  /** How many leading messages were checked on an earlier turn (and so are already redacted in the caller's history); the check starts after them. */
  checkedUpTo: number;
  timeoutMs?: number;
}

export type LlmChatResult =
  | {
      ok: true;
      text: string | null;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
      promptTokens: number;
      completionTokens: number;
      /** The conversation as it was sent, with any redaction applied; the caller keeps this as its history. */
      messages: LiteLlmChatMessage[];
      /** The model ran out of room to write: the text is cut off. */
      truncated: boolean;
    }
  /** Nothing was sent: a budget, a rate limit, a guardrail or the preset's egress rule said no. */
  | { ok: false; reason: 'refused'; detail: string; decision: LlmCallDecision }
  /** The alias is not one this deployment knows (`unbound`), the proxy could not answer (`unavailable`), or the call ran out of time (`timeout`). */
  | { ok: false; reason: 'unbound' | 'unavailable' | 'timeout'; detail: string };

const allowRate: RateHit = () => ({ allowed: true, retryAfterMs: 0 });

/**
 * Opens a short system transaction for one step of a turn. A turn is three steps: the check (a transaction), the call to the proxy (NO transaction: it may take minutes, and a held
 * connection is one the pool cannot give anyone else), and the spend line (a transaction). The caller supplies this; the gateway never holds a connection across the call.
 */
export type ChatTx = <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;

/** A message the gateway checks: what a person or a tool wrote. The system text is the platform's own and a model's own words (assistant) are not an input. */
const isChecked = (m: LiteLlmChatMessage): boolean => (m.role === 'user' || m.role === 'tool') && m.content !== null && m.content !== '';

export async function chat(
  ctx: PluginContext,
  run: ChatTx,
  rate: RateHit,
  request: LlmChatRequest,
  gateway: LlmGateway = gatewayFromEnv(),
): Promise<LlmChatResult> {
  const named = LlmAliasName.safeParse(request.alias);
  if (!named.success) {
    return { ok: false, reason: 'unbound', detail: `The model alias "${request.alias}" is not one of ${ALL_ALIASES.join(', ')}.` };
  }
  const alias = named.data;
  const sessionId = request.runId ?? request.sessionId ?? null;
  // The check: the alias must be bound, then every user and tool message added since the last turn passes the pre-call check one by one (parallel tool calls bring several at once). A
  // redaction rewrites the message in the copy that is sent AND in the copy handed back, which the caller keeps as its history: a secret is redacted once and never goes out again.
  const checked = await run(async (tx): Promise<{ messages: LiteLlmChatMessage[] } | LlmChatResult> => {
    if ((await loadEgress(tx, request.workspaceId, alias)) === null) {
      return { ok: false, reason: 'unbound', detail: `The ${request.alias} alias is not bound to a model in this workspace.` };
    }
    const messages = request.messages.map((m) => ({ ...m }));
    let first = true;
    for (let i = request.checkedUpTo; i < messages.length; i += 1) {
      const message = messages[i]!;
      if (!isChecked(message)) continue;
      const decision = await preflight(ctx, tx, request.firstTurn && first ? rate : allowRate, {
        workspaceId: request.workspaceId,
        botId: request.botId,
        teamId: request.teamId,
        sessionId,
        alias,
        text: message.content!,
      });
      first = false;
      if (!decision.allowed) {
        return { ok: false, reason: 'refused', detail: "The workspace's model limits or guardrails did not allow the call.", decision };
      }
      message.content = decision.text;
    }
    return { messages };
  });
  if ('ok' in checked) return checked;
  const messages = checked.messages;
  if (!gateway.enabled) return { ok: false, reason: 'unavailable', detail: 'No LLM gateway URL is configured.' };
  try {
    const answer = await gateway.chat({
      model: request.alias,
      messages,
      tools: request.tools,
      maxTokens: request.maxTokens,
      metadata: {
        manythreads_workspace: request.workspaceId,
        ...(request.botId === null ? {} : { manythreads_bot: request.botId }),
        ...(request.runId === null ? {} : { manythreads_run: request.runId }),
        purpose: request.purpose ?? 'run',
      },
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    await run((tx) =>
      recordSpend(tx, {
        workspaceId: request.workspaceId,
        teamId: request.teamId,
        botId: request.botId,
        sessionId,
        runId: request.runId,
        alias,
        model: answer.model,
        promptTokens: answer.promptTokens,
        completionTokens: answer.completionTokens,
        costUsd: 0,
      }),
    );
    return { ok: true, text: answer.text, toolCalls: answer.toolCalls, promptTokens: answer.promptTokens, completionTokens: answer.completionTokens, messages, truncated: answer.truncated };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { ok: false, reason: 'timeout', detail: `The ${request.alias} alias did not answer in time.` };
    const raw = err instanceof Error ? err.message : '';
    if (/\b429\b|rate.?limit/i.test(raw)) return { ok: false, reason: 'unavailable', detail: `The ${request.alias} alias is rate limited right now.` };
    const detail = err instanceof Error ? scrubProxyDetail(err.message) : 'the call failed';
    return { ok: false, reason: 'unavailable', detail: `The ${request.alias} alias did not answer: ${detail}`.slice(0, 400) };
  }
}
