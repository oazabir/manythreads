import type { PluginContext, PluginTx, ProviderImpl } from '@manythreads/sdk';
import { requestKeyCheck } from './keys.ts';
import { classify, type LlmClassifyRequest, type LlmClassifyResult } from './complete.ts';
import { createSlidingWindow, preflight, recordSpend, type LlmCallDecision, type LlmCallRequest, type LlmSpendRecord } from './limits.ts';

// The `provider.llm` contract (SPEC §10.2, PLAN P5-06 and P5-07). A bot's runtime does not reach LiteLLM itself; it is
// handed the gateway URL and its own virtual key, asks for aliases, and — since P5-07 — asks permission before every
// call. This is the one door the runtimes of P5-09/P5-10 use, and none of it leaves the system actor: the key and the
// limits are read in a system transaction, which is exactly the trust level a run already has.

export interface LlmProviderServices extends ProviderImpl {
  id: string;
  /** The bot's live virtual key (null when it has none). System transaction only — `ctx.secrets.get` refuses any other. */
  botKey(tx: PluginTx, botId: string): Promise<string | null>;
  /** The proxy answered 401 to this bot's key: queue a check of the key at the proxy (registered again if the proxy lost it). Cheap, deduplicated, rate-limited. */
  keyRejected(tx: PluginTx, botId: string): Promise<void>;
  /**
   * Everything the gateway knows before a model call: the preset's egress rule, the pre-call DLP hook and every
   * applicable budget and rate limit. A refusal is answered with its reason and an event, never by throwing, so a
   * runtime can log it and stop the run cleanly. The text to send is `decision.text` (redacted when the hook said so).
   */
  preflight(tx: PluginTx, request: LlmCallRequest): Promise<LlmCallDecision>;
  /** Append what a call cost to `llm_spend`; answers the ledger line's id. */
  recordSpend(tx: PluginTx, record: LlmSpendRecord): Promise<string>;
  /**
   * The gate's classifier call (PLAN P5-11): one completion on the `local` alias for the text of one piece of a message. The pre-call check, the master
   * key and the ledger line are inside; so is what makes it safe — the alias and its whole fallback chain must be a model inside this deployment (an
   * admin-marked provider or a loopback host), else the answer is `unavailable` and nothing is sent; and only piece 0 is a hit on the rate limit.
   * Neither is a flag the caller sets. Never throws for an unavailable model; the answer says why there is none, and the caller decides what that means.
   */
  classify(tx: PluginTx, request: LlmClassifyRequest): Promise<LlmClassifyResult>;
}

export function registerLlmProvider(ctx: PluginContext): LlmProviderServices {
  // One limiter per process, shared by every runtime call (PLAN D3: rate limits live in process memory, per replica).
  const window = createSlidingWindow();
  const impl: LlmProviderServices = {
    id: 'gateway-llm',
    async botKey(tx, botId) {
      const row = (
        await tx.query<{ secret_id: string | null }>('SELECT secret_id FROM app.llm_keys WHERE bot_id = $1 AND revoked_at IS NULL', [botId])
      ).rows[0];
      if (!row?.secret_id) return null;
      return ctx.secrets.get(tx, row.secret_id);
    },
    keyRejected: async (tx, botId) => {
      await requestKeyCheck(ctx, tx, botId);
    },
    preflight: (tx, request) => preflight(ctx, tx, window.hit, request),
    recordSpend: (tx, record) => recordSpend(tx, record),
    classify: (tx, request) => classify(ctx, tx, window.hit, request),
  };
  ctx.providers.register('llm', impl);
  return impl;
}
