import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { gatewayFromEnv } from './gateway.ts';
import { scrubProxyDetail } from './litellm.ts';
import { loadEgress, loadFallbackChain, preflight, recordSpend, type LlmCallDecision, type RateHit } from './limits.ts';

// The one completion the platform makes for itself (PLAN P5-11: the gate's classifier on the `local` alias), through the same door as every
// other model call: the pre-call check first (the guardrails, the budgets and the rate limits, all of which count the caller's bot and run),
// then the proxy with the master key, then a line in the spend ledger. It answers, it never throws for an unavailable model: the caller decides
// what unavailable means (the gate fails closed).
//
// It is deliberately NOT a general "complete": what makes it safe to call with a person's message is fixed here and cannot be switched off by a
// caller. The alias is `local`; the alias and every link of its fallback chain must be a model that runs inside this deployment (SPEC §7.3: the
// classifier "never" uses a remote provider); and the second and later pieces of one long message are not further hits on the rate limit — that
// is derived from `piece`, not a flag a caller could set to dodge a limit.

export interface LlmClassifyRequest {
  workspaceId: string;
  botId: string | null;
  teamId: string | null;
  /** The run this is for: budgets and the ledger attribute the call to it. */
  runId: string;
  /** The fixed instruction. Not scanned: it is ours, and it is not what a person wrote. */
  system: string;
  /** The text that leaves, and the only thing the guardrails look at. */
  text: string;
  maxTokens: number;
  /** Which piece of one long message this is, counting from 0. Piece 0 is a hit on the rate limit; later pieces count against budgets only. */
  piece: number;
  timeoutMs?: number;
}

export type LlmClassifyResult =
  /** The model answered. `text` is its answer; `sent` is what actually left (redacted when the guardrails rewrote it). */
  | { ok: true; text: string; sent: string; decision: LlmCallDecision }
  /** The pre-call check said no: a budget or rate limit, the preset's egress rule, a detection the preset refuses. Nothing was sent. */
  | { ok: false; reason: 'refused'; decision: LlmCallDecision }
  /** The alias is bound to nothing (`unbound`), is not a model inside this deployment, or the proxy could not answer (`unavailable`). Nothing was sent or came back. */
  | { ok: false; reason: 'unbound' | 'unavailable'; detail: string };

const ALIAS = 'local';
const allowRate: RateHit = () => ({ allowed: true, retryAfterMs: 0 });

export async function classify(ctx: PluginContext, tx: PluginTx, rate: RateHit, request: LlmClassifyRequest): Promise<LlmClassifyResult> {
  const target = await loadEgress(tx, request.workspaceId, ALIAS);
  if (target === null) {
    return { ok: false, reason: 'unbound', detail: `The ${ALIAS} alias is not bound to a model.` };
  }
  // "Local" is one thing everywhere (strict-egress, air-gapped, here): the provider's own flag, set by the admin, or a loopback host.
  const links = [{ alias: ALIAS as string, egress: target }, ...(await loadFallbackChain(tx, request.workspaceId, ALIAS))];
  const remote = links.find((link) => !(link.egress?.local ?? false));
  if (remote) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: `The ${remote.alias} alias is not a model inside this deployment${remote.egress?.host ? ` (it goes to ${remote.egress.host})` : ''}; mark its provider "runs inside this deployment" if it is, because the classifier only runs on one.`,
    };
  }
  const decision = await preflight(ctx, tx, request.piece > 0 ? allowRate : rate, {
    workspaceId: request.workspaceId,
    botId: request.botId,
    teamId: request.teamId,
    sessionId: request.runId,
    alias: ALIAS,
    text: request.text,
  });
  if (!decision.allowed) return { ok: false, reason: 'refused', decision };

  const gateway = gatewayFromEnv();
  if (!gateway.enabled) return { ok: false, reason: 'unavailable', detail: 'No LLM gateway URL is configured.' };
  try {
    const answer = await gateway.complete({
      model: ALIAS,
      system: request.system,
      user: decision.text,
      maxTokens: request.maxTokens,
      metadata: { manythreads_workspace: request.workspaceId, ...(request.botId ? { manythreads_bot: request.botId } : {}), purpose: 'gate' },
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    await recordSpend(tx, {
      workspaceId: request.workspaceId,
      teamId: request.teamId,
      botId: request.botId,
      sessionId: request.runId,
      runId: /^[0-9a-f-]{36}$/i.test(request.runId) ? request.runId : null,
      alias: ALIAS,
      model: answer.model,
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      // The proxy reports tokens, not money; a model inside the deployment costs nothing per call.
      costUsd: 0,
    });
    return { ok: true, text: answer.text, sent: decision.text, decision };
  } catch (err) {
    // The proxy's message can echo request fields; it is scrubbed before it lands in a log line.
    const detail = err instanceof Error ? scrubProxyDetail(err.message) : 'the call failed';
    return { ok: false, reason: 'unavailable', detail: `The ${ALIAS} alias did not answer: ${detail}`.slice(0, 400) };
  }
}
