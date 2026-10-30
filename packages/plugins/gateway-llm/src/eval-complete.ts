import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { LlmAliasName } from '@manythreads/shared';
import { ALL_ALIASES } from './config.ts';
import { gatewayFromEnv } from './gateway.ts';
import { scrubProxyDetail } from './litellm.ts';
import { loadEgress, preflight, recordSpend, type LlmCallDecision, type RateHit } from './limits.ts';

// The one completion the bots plugin's eval harness makes (PLAN P7-08): a lead asked for a bot's scenario set to be run WITH the model, so each case's
// prompt (the BOT.md body and the case's world, written by a lead and never a person's message) goes to the bot's own first alias. It goes through the
// same door as every other model call: the pre-call check first (the preset's egress rule, the guardrails, the budgets), then the proxy with the master
// key (an eval is a call the platform makes about a bot, not a run of the bot, so it does not depend on the bot's virtual key), then a line in the
// spend ledger attributed to the bot. Like `classify` it answers and never throws for an unavailable model. Unlike `classify` it may use any bound
// alias (the point is to test the model the bot really uses), and it is not a hit on the bot's per-minute rate limit: a 20-case run would trip it
// and fail a run for a reason that has nothing to do with the prompt; budgets still count every token.

export interface LlmEvalRequest {
  workspaceId: string;
  botId: string;
  teamId: string;
  /** The eval run this is for: the ledger attributes the call to it. */
  runId: string;
  /** The alias the bot's definition asks for first. */
  alias: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
}

export type LlmEvalResult =
  | { ok: true; text: string; tokens: number; decision: LlmCallDecision }
  /** Nothing was sent: a budget, a guardrail or the preset's egress rule said no. */
  | { ok: false; reason: 'refused'; detail: string; decision: LlmCallDecision }
  /** The alias is not one this deployment knows (`unbound`), or the proxy could not answer (`unavailable`). */
  | { ok: false; reason: 'unbound' | 'unavailable'; detail: string };

const allowRate: RateHit = () => ({ allowed: true, retryAfterMs: 0 });

export async function evalComplete(ctx: PluginContext, tx: PluginTx, request: LlmEvalRequest): Promise<LlmEvalResult> {
  const named = LlmAliasName.safeParse(request.alias);
  if (!named.success) {
    return { ok: false, reason: 'unbound', detail: `The model alias "${request.alias}" is not one of ${ALL_ALIASES.join(', ')}.` };
  }
  const alias = named.data;
  const target = await loadEgress(tx, request.workspaceId, alias);
  if (target === null) {
    return { ok: false, reason: 'unbound', detail: `The ${request.alias} alias is not bound to a model in this workspace.` };
  }
  const decision = await preflight(ctx, tx, allowRate, {
    workspaceId: request.workspaceId,
    botId: request.botId,
    teamId: request.teamId,
    sessionId: request.runId,
    alias,
    text: request.user,
  });
  if (!decision.allowed) {
    return { ok: false, reason: 'refused', detail: 'The workspace\'s model limits or guardrails did not allow the call.', decision };
  }
  const gateway = gatewayFromEnv();
  if (!gateway.enabled) return { ok: false, reason: 'unavailable', detail: 'No LLM gateway URL is configured.' };
  try {
    const answer = await gateway.complete({
      model: request.alias,
      system: request.system,
      user: decision.text,
      maxTokens: request.maxTokens,
      metadata: { manythreads_workspace: request.workspaceId, manythreads_bot: request.botId, purpose: 'eval' },
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    await recordSpend(tx, {
      workspaceId: request.workspaceId,
      teamId: request.teamId,
      botId: request.botId,
      sessionId: request.runId,
      runId: null,
      alias,
      model: answer.model,
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      costUsd: 0,
    });
    return { ok: true, text: answer.text, tokens: answer.promptTokens + answer.completionTokens, decision };
  } catch (err) {
    const raw = err instanceof Error ? err.message : '';
    if (/\b429\b|rate.?limit/i.test(raw)) return { ok: false, reason: 'unavailable', detail: `The ${request.alias} alias is rate limited right now. Run the evals with the model again in a few minutes.` };
    const detail = err instanceof Error ? scrubProxyDetail(err.message) : 'the call failed';
    return { ok: false, reason: 'unavailable', detail: `The ${request.alias} alias did not answer: ${detail}`.slice(0, 400) };
  }
}
