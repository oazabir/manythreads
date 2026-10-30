import { definePlugin } from '@manythreads/sdk';
import { registerConfigJob } from './config.ts';
import { registerBootHealJob, registerKeySubscriptions, registerReconcileJob, registerSyncKeyJob } from './keys.ts';
import { registerLlmProvider } from './provider.ts';
import { registerLlmRoutes } from './routes.ts';
import { registerRunProxy } from './run-proxy.ts';

export { ALL_ALIASES, buildConfigDocument, configFingerprint, pushLlmConfig, registerConfigJob, resolveModel } from './config.ts';
export type { AliasRow, KeyRow, ProviderRow } from './rows.ts';
export { botKeyModels, keyPrefix, mintBotKey, newBotKey, requestKeyCheck, revokeBotKey, syncBotKey, syncWorkspaceKeys } from './keys.ts';
export type { KeySyncResult } from './keys.ts';
export { createLiteLlmClient, LiteLlmError } from './litellm.ts';
export type { LiteLlmConfigDocument, LiteLlmTransport, LlmGateway } from './litellm.ts';
export { APPLY_CONFIG_QUEUE, BOOT_HEAL_QUEUE, RECONCILE_QUEUE, SYNC_KEY_QUEUE, gatewayFromEnv } from './gateway.ts';
export type { LlmProviderServices } from './provider.ts';
export { classify } from './complete.ts';
export { MAX_PROXY_BODY_BYTES, runProxyHandlers, type RunProxyDeps } from './run-proxy.ts';
export type { LlmClassifyRequest, LlmClassifyResult } from './complete.ts';
export { evalComplete } from './eval-complete.ts';
export type { LlmEvalRequest, LlmEvalResult } from './eval-complete.ts';
export { createSlidingWindow, decide, loadEgress, loadFallbackChain, loadLimits, loadSettings, preflight, rateKey, recordSpend, spendSummary, windowStart } from './limits.ts';
export type { EgressTarget, LlmCallDecision, LlmCallRequest, LlmScopeSnapshot, LlmSpendRecord, RateHit } from './limits.ts';

/**
 * gateway-llm: the workspace's door to the models (SPEC §10.1, PLAN P5-06). One LiteLLM proxy runs in the
 * `manythreads-llm` compose service and this plugin owns its config: providers, the eight aliases (smart fast code local
 * embed vision image transcribe) and the fallback chains all come from the database, and every change is pushed. Each bot
 * is minted a virtual key when it loads and loses it when it is removed, so usage and budgets (P5-07) attach to a bot
 * rather than to the workspace. `provider.llm` is the door the runtimes of P5-09/P5-10 use to fetch a bot's key; the
 * `ctx.secrets` door it also declares is the one the kernel opens to model providers (docs/plugins/security.md).
 */
export default definePlugin({
  manifest: {
    name: 'gateway-llm',
    version: '0.1.0',
    kind: 'server',
    migrations: 'migrations',
    // `run.resolve` for one thing: turning a presented run token into its run (`ctx.runs.resolve`) in the run-scoped model proxy
    // (run-proxy.ts). It opens no run and enters no transaction as a bot.
    extends: ['event.subscribe', 'event.emit', 'job.register', 'provider.llm', 'hook.pre_egress', 'run.resolve'],
    events: {
      emits: ['llm.config.applied', 'llm.key.changed', 'llm.budget.exceeded', 'llm.guard.decided', 'llm.alias.tested'],
      consumes: ['bots.bot.loaded', 'bots.bot.removed'],
    },
    // The guardrails (P5-21) are what the pre-call check runs: where a call may go (egress, first) and what it may carry (dlp).
    dependsOn: ['guardrails-egress', 'guardrails-dlp'],
  },
  register(ctx) {
    registerConfigJob(ctx);
    registerSyncKeyJob(ctx);
    registerReconcileJob(ctx);
    registerBootHealJob(ctx);
    registerKeySubscriptions(ctx);
    const llm = registerLlmProvider(ctx);
    registerRunProxy(ctx, (tx, botId) => llm.botKey(tx, botId), (tx, botId) => llm.keyRejected(tx, botId));
    registerLlmRoutes(ctx);
  },
});
