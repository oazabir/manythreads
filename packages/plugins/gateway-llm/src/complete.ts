import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { LlmAliasName } from '@manythreads/shared';
import { gatewayFromEnv } from './gateway.ts';
import { scrubProxyDetail } from './litellm.ts';
import { loadEgress, loadFallbackChain, preflight, recordSpend, type LlmCallDecision, type RateHit } from './limits.ts';

// A completion the platform makes for itself (PLAN P5-11: the gate's classifier on the `local` alias), through the same door as every other
// model call: the pre-call check first (the guardrails, the budgets and the rate limits, all of which count the caller's bot and run), then
// the proxy with the master key, then a line in the spend ledger. It answers, it never throws for an unavailable model: the caller decides
// what unavailable means (the gate fails closed).

export interface LlmCompleteRequest {
  workspaceId: string;
  botId: string | null;
  teamId: string | null;
  /** The run this is for (budgets and the ledger attribute the call to it). */
  sessionId: string | null;
  alias: LlmAliasName;
  /** The fixed instruction. Not scanned: it is ours, and it is not what a person wrote. */
  system: string;
  /** The text that leaves, and the only thing the guardrails look at. */
  text: string;
  maxTokens: number;
  /** What the call is for, recorded with the proxy's metadata (`gate`). */
  purpose: string;
  timeoutMs?: number;
  /**
   * The call may only run on a model on this machine (SPEC §7.3: the gate's classifier "never" uses a remote provider). Not just the alias's name: the
   * alias's provider **and every link of its fallback chain** must resolve to a local host, or the answer is `unavailable` and nothing is sent. An admin
   * can bind `local` to a hosted provider; this is what keeps a message from leaving the box through it.
   */
  localOnly?: boolean;
  /** A later piece of one job: it counts against the budgets like any call but is not another hit on the rate limit (a long message is one check, not eight). */
  followUp?: boolean;
}

export type LlmCompleteResult =
  /** The model answered. `text` is its answer; `sent` is what actually left (redacted when the guardrails rewrote it). */
  | { ok: true; text: string; sent: string; decision: LlmCallDecision }
  /** The pre-call check said no: a budget or rate limit, the preset's egress rule, a detection the preset refuses. Nothing was sent. */
  | { ok: false; reason: 'refused'; decision: LlmCallDecision }
  /** The alias is bound to nothing (`unbound`) or the proxy could not answer (`unavailable`: no URL, an error, a timeout). Nothing came back. */
  | { ok: false; reason: 'unbound' | 'unavailable'; detail: string };

export async function complete(ctx: PluginContext, tx: PluginTx, rate: RateHit, request: LlmCompleteRequest): Promise<LlmCompleteResult> {
  const target = await loadEgress(tx, request.workspaceId, request.alias);
  if (target === null) {
    return { ok: false, reason: 'unbound', detail: `The ${request.alias} alias is not bound to a model.` };
  }
  if (request.localOnly) {
    const links = [{ alias: request.alias as string, egress: target }, ...(await loadFallbackChain(tx, request.workspaceId, request.alias))];
    const remote = links.find((link) => !(link.egress?.local ?? false));
    if (remote) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: `The ${remote.alias} alias is not a model on this machine${remote.egress?.host ? ` (it goes to ${remote.egress.host})` : ''}, and this call only runs on one.`,
      };
    }
  }
  const allowRate: RateHit = () => ({ allowed: true, retryAfterMs: 0 });
  const decision = await preflight(ctx, tx, request.followUp ? allowRate : rate, {
    workspaceId: request.workspaceId,
    botId: request.botId,
    teamId: request.teamId,
    sessionId: request.sessionId,
    alias: request.alias,
    text: request.text,
  });
  if (!decision.allowed) return { ok: false, reason: 'refused', decision };

  const gateway = gatewayFromEnv();
  if (!gateway.enabled) return { ok: false, reason: 'unavailable', detail: 'No LLM gateway URL is configured.' };
  try {
    const answer = await gateway.complete({
      model: request.alias,
      system: request.system,
      user: decision.text,
      maxTokens: request.maxTokens,
      metadata: { workspace_id: request.workspaceId, ...(request.botId ? { bot_id: request.botId } : {}), purpose: request.purpose },
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    await recordSpend(tx, {
      workspaceId: request.workspaceId,
      teamId: request.teamId,
      botId: request.botId,
      sessionId: request.sessionId,
      runId: request.sessionId !== null && /^[0-9a-f-]{36}$/i.test(request.sessionId) ? request.sessionId : null,
      alias: request.alias,
      model: answer.model,
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      // The proxy reports tokens, not money; the alias this is for is `local` (a model on this machine), which costs nothing per call.
      costUsd: 0,
    });
    return { ok: true, text: answer.text, sent: decision.text, decision };
  } catch (err) {
    // The proxy's message can echo request fields; it is scrubbed before it lands in a log line.
    const detail = err instanceof Error ? scrubProxyDetail(err.message) : 'the call failed';
    return { ok: false, reason: 'unavailable', detail: `The ${request.alias} alias did not answer: ${detail}`.slice(0, 400) };
  }
}
