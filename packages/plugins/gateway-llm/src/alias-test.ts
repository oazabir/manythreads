import type { PluginContext } from '@manythreads/sdk';
import {
  LLM_TESTABLE_ALIASES,
  LlmAliasName,
  LlmAliasTest,
  type LlmAliasTestCause,
} from '@manythreads/shared';
import { gatewayFromEnv } from './gateway.ts';
import { allowRate } from './eval-complete.ts';
import { LiteLlmError, type LlmGateway } from './litellm.ts';
import { preflight, recordSpend } from './limits.ts';

// The test call of one model alias (PLAN P10-01 step 2). An admin on the setup page asks "does this model answer?" and gets a real answer to a real
// call, not a green tick for a row that exists. The call goes the way every platform-made model call goes (see `eval-complete.ts`): the pre-call check
// first (the preset's egress rule, the guardrails, the budgets), then the proxy with the master key, then a line in the spend ledger. The result is
// kept per alias in `llm_alias_tests`; the read side decides whether it is still current.
//
// The text shown to the admin is chosen here from the cause. The provider's own error text is never copied into it: it can echo a key or a prompt.

const TEST_SYSTEM = 'You are a connection check for a team chat platform. Answer with exactly one word.';
const TEST_USER = 'Reply with the single word: ready';
const TEST_MAX_TOKENS = 64;
/** How long the test waits for the model. A slow local model that is still loading can take a while; a wrong address should not hang the page. */
export const DEFAULT_TEST_TIMEOUT_MS = 20_000;

const TESTABLE = new Set<string>(LLM_TESTABLE_ALIASES);
export const isTestableAlias = (alias: LlmAliasName): boolean => TESTABLE.has(alias);

/** The plain sentence for each way a test can fail (and for passing: `null`). One place, so the screen and the docs agree. */
export function causeMessage(cause: LlmAliasTestCause | null, extra: { seconds?: number } = {}): string {
  switch (cause) {
    case null:
      return 'The model answered.';
    case 'no_gateway':
      return 'This server has no model proxy (the service that forwards calls to your provider) set up, so nothing can be tested yet. Ask whoever runs the server to set its address.';
    case 'unbound':
      return 'This alias is not connected to a working model yet. Choose a provider that is switched on and a model name, save, and test again.';
    case 'refused':
      return 'A spending limit, a rate limit or a data-protection rule stopped the test before it left. Look at Limits and Data protection in Settings.';
    case 'auth':
      return 'The provider refused the key. Check that the key was copied whole and belongs to this provider, then save it again and test.';
    case 'model_not_found':
      return 'The provider does not know this model name. Check the spelling against the provider\'s own list. If you saved it a moment ago, wait ten seconds and test again.';
    case 'rate_limited':
      return 'The provider says it is being asked too often, or the account is out of credit. Wait a minute and test again, and check the provider\'s billing page.';
    case 'provider_error':
      return 'The provider had an error of its own. Try again shortly; if it keeps happening, check the provider\'s status page.';
    case 'timeout':
      return `No answer came within ${extra.seconds ?? 20} seconds. The address may be wrong, or a local model may still be loading.`;
    case 'unreachable':
      return 'The model proxy could not be reached. Check that it is running, then test again.';
    case 'empty_answer':
      return 'The model replied with no text. Try a different model name for this alias.';
    case 'other':
      return 'The call failed for a reason this page cannot name. Test again; if it keeps failing, ask whoever runs the server to check the model proxy.';
  }
}

/** Maps what the proxy client threw to one of the causes. Reads the status and, for a 400, the proxy's wording about an unknown model. */
export function classifyFailure(err: unknown): LlmAliasTestCause {
  if (err instanceof LiteLlmError) {
    if (err.status === 0) return 'no_gateway';
    if (err.status === 401 || err.status === 403) return 'auth';
    if (err.status === 404) return 'model_not_found';
    if (err.status === 400 && /invalid model|model.*(not found|does not exist)|unknown model/i.test(err.message)) return 'model_not_found';
    if (err.status === 429) return 'rate_limited';
    if (err.status === 408 || err.status === 504) return 'timeout';
    if (err.status >= 500) return 'provider_error';
    if (/no text/i.test(err.message)) return 'empty_answer';
    return 'other';
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return 'timeout';
  // `fetch` rejects with a TypeError when nothing answered at the address (refused connection, unknown host).
  if (err instanceof TypeError) return 'unreachable';
  return 'other';
}

interface AliasFacts {
  model: string;
  providerEnabled: boolean | null;
  providerId: string | null;
}

export interface AliasTestOptions {
  workspaceId: string;
  alias: LlmAliasName;
  /** The actor who asked (a person). */
  testedBy: string | null;
  /** Test seam; defaults to the proxy named by the environment. */
  gateway?: LlmGateway;
  timeoutMs?: number;
}

/**
 * Runs one test call and stores its result. Never throws for a model that cannot answer: that is the result. The transaction is not held open
 * while the model thinks: it is three short system transactions around the call.
 */
export async function runAliasTest(ctx: PluginContext, options: AliasTestOptions): Promise<LlmAliasTest> {
  const { workspaceId, alias } = options;
  const gateway = options.gateway ?? gatewayFromEnv();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const started = Date.now();

  // `testedAt` is when the test STARTED (the database's clock): an alias or provider edit that lands while the model is thinking is then newer
  // than the result, which is stale from the start.
  let startedAt: Date | null = null;
  const store = (outcome: 'ok' | 'failed', cause: LlmAliasTestCause | null, model: string | null, spend?: { prompt: number; completion: number }) =>
    ctx.db.system(
      async (tx) => {
        if (spend) {
          await recordSpend(tx, {
            workspaceId,
            teamId: null,
            botId: null,
            sessionId: null,
            runId: null,
            alias,
            model,
            promptTokens: spend.prompt,
            completionTokens: spend.completion,
            costUsd: 0,
          });
        }
        const message = causeMessage(cause, { seconds: Math.round(timeoutMs / 1000) });
        const latencyMs = Math.max(0, Date.now() - started);
        const row = (
          await tx.query<{ tested_at: Date }>(
            `INSERT INTO app.llm_alias_tests AS t (workspace_id, alias, outcome, cause, message, model, latency_ms, tested_at, tested_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($9::timestamptz, now()), $8)
             ON CONFLICT (workspace_id, alias) DO UPDATE SET outcome = EXCLUDED.outcome, cause = EXCLUDED.cause, message = EXCLUDED.message,
               model = EXCLUDED.model, latency_ms = EXCLUDED.latency_ms, tested_at = EXCLUDED.tested_at, tested_by = EXCLUDED.tested_by
             RETURNING tested_at`,
            [workspaceId, alias, outcome, cause, message, model === null ? null : model.slice(0, 200), latencyMs, options.testedBy, startedAt],
          )
        ).rows[0];
        const testedAt = row?.tested_at ?? new Date();
        await ctx.audit.emit(tx, {
          type: 'llm.alias.tested',
          workspaceId,
          alias,
          outcome,
          cause,
          testedBy: options.testedBy,
          at: testedAt.toISOString(),
        });
        return LlmAliasTest.parse({
          alias,
          outcome,
          cause,
          message,
          model: model === null ? null : model.slice(0, 200),
          latencyMs,
          testedAt: testedAt.toISOString(),
          testedBy: options.testedBy,
          current: true,
        });
      },
      { workspaceId },
    );

  // 1. What the alias points at, and the pre-call check.
  const gate = await ctx.db.system(
    async (tx) => {
      startedAt = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now ?? null;
      const facts = (
        await tx.query<{ model: string; provider_id: string | null; provider_enabled: boolean | null }>(
          `SELECT a.model, a.provider_id, p.enabled AS provider_enabled
             FROM app.llm_aliases a LEFT JOIN app.llm_providers p ON p.id = a.provider_id
            WHERE a.workspace_id = $1 AND a.alias = $2`,
          [workspaceId, alias],
        )
      ).rows[0];
      if (!facts) return { stop: 'unbound' as const };
      const known: AliasFacts = { model: facts.model, providerId: facts.provider_id, providerEnabled: facts.provider_enabled };
      if (known.providerId !== null && known.providerEnabled === false) return { stop: 'unbound' as const };
      const decision = await preflight(ctx, tx, allowRate, {
        workspaceId,
        botId: null,
        teamId: null,
        sessionId: null,
        alias,
        text: TEST_USER,
      });
      if (!decision.allowed) return { stop: 'refused' as const };
      return { stop: null, text: decision.text };
    },
    { workspaceId },
  );
  if (gate.stop !== null) return store('failed', gate.stop, null);
  if (!gateway.enabled) return store('failed', 'no_gateway', null);

  // 2. The call itself, outside any transaction.
  let answer: Awaited<ReturnType<LlmGateway['complete']>>;
  try {
    answer = await gateway.complete({
      model: alias,
      system: TEST_SYSTEM,
      user: gate.text,
      maxTokens: TEST_MAX_TOKENS,
      metadata: { manythreads_workspace: workspaceId, purpose: 'alias-test' },
      timeoutMs,
      noFallbacks: true,
    });
  } catch (err) {
    return store('failed', classifyFailure(err), null);
  }

  // 3. A call that came back is recorded as spend either way; an empty answer is still a failed test.
  if (answer.text.trim() === '') return store('failed', 'empty_answer', answer.model, { prompt: answer.promptTokens, completion: answer.completionTokens });
  return store('ok', null, answer.model, { prompt: answer.promptTokens, completion: answer.completionTokens });
}
