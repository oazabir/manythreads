import { definePlugin } from '@manythreads/sdk';
import { registerConfigJob } from './config.ts';
import { registerKeySubscriptions, registerReconcileJob, registerSyncKeyJob } from './keys.ts';
import { registerLlmProvider } from './provider.ts';
import { registerLlmRoutes } from './routes.ts';

export { ALL_ALIASES, buildConfigDocument, configFingerprint, pushLlmConfig, registerConfigJob, resolveModel } from './config.ts';
export type { AliasRow, KeyRow, ProviderRow } from './rows.ts';
export { botKeyModels, keyPrefix, mintBotKey, newBotKey, revokeBotKey, syncBotKey, syncWorkspaceKeys } from './keys.ts';
export type { KeySyncResult } from './keys.ts';
export { createLiteLlmClient, LiteLlmError } from './litellm.ts';
export type { LiteLlmConfigDocument, LiteLlmTransport, LlmGateway } from './litellm.ts';
export { APPLY_CONFIG_QUEUE, RECONCILE_QUEUE, SYNC_KEY_QUEUE, gatewayFromEnv } from './gateway.ts';
export type { LlmProviderServices } from './provider.ts';
export { createSlidingWindow, decide, loadEgress, loadFallbackChain, loadLimits, loadSettings, preflight, rateKey, recordSpend, spendSummary, windowStart } from './limits.ts';
export type { EgressTarget, LlmCallDecision, LlmCallRequest, LlmScopeSnapshot, LlmSpendRecord, RateHit } from './limits.ts';
export { inspect, scan } from './dlp.ts';
export type { DlpFinding, DlpResult } from './dlp.ts';

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
    extends: ['event.subscribe', 'event.emit', 'job.register', 'provider.llm'],
    events: {
      emits: ['llm.config.applied', 'llm.key.changed', 'llm.budget.exceeded', 'llm.guard.decided'],
      consumes: ['bots.bot.loaded', 'bots.bot.removed'],
    },
  },
  register(ctx) {
    registerConfigJob(ctx);
    registerSyncKeyJob(ctx);
    registerReconcileJob(ctx);
    registerKeySubscriptions(ctx);
    registerLlmProvider(ctx);
    registerLlmRoutes(ctx);
  },
});
