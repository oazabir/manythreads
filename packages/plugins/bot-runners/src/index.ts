import { definePlugin } from '@manythreads/sdk';
import { createModelRuntime } from './model-runtime.ts';
import { createBotRunnersProvider } from './resolve.ts';
import { registerRoutes } from './routes.ts';

export { DEFAULT_PROFILE_RULE, resolveRunner } from './resolve.ts';
export { createModelRuntime, DEFAULT_STEP_LIMIT, MODEL_RUNTIME_ID } from './model-runtime.ts';

/**
 * bot-runners (PLAN P19-02): the catalog of places a bot can run, set up by a workspace admin. A runner is a Hermes gateway (an address and a key), the team's
 * Hermes pod, a Claude Code or Codex pod (later tasks) or the platform's own LLM gateway (answered by the `model` runtime in `model-runtime.ts`). The admin says which teams may use each one and which is the default;
 * a team member reads only the short view (name, kind, state, owner's name and plan). The address, key and node of a runner never reach anyone but an admin.
 * `resolveRunner` (the `bot.runners` provider) turns a runner's name into where a run goes, for runtime-hermes. An admin can adopt a team's old Hermes
 * connection into a runner without touching any BOT.md. docs/plugins/bot-runners.md.
 */
export default definePlugin({
  manifest: {
    name: 'bot-runners',
    version: '0.1.0',
    kind: 'server',
    // `secret.seal` encrypts a Hermes gateway's key; `provider.bot.runners` is the resolver runtime-hermes asks.
    extends: ['event.emit', 'provider.bot.runners', 'provider.bot_runtime', 'secret.seal'],
    events: {
      emits: [
        'bot_runner.runner.created',
        'bot_runner.runner.updated',
        'bot_runner.runner.deleted',
        'bot_runner.runner.tested',
        'bot_runner.availability.changed',
        'bot_runner.default.changed',
        'bot_runner.node.changed',
        'bot_runner.terms.accepted',
      ],
      consumes: [],
    },
    // `teams` owns the teams a runner is shared with; `bots` the placements that are counted before a delete; `runtime-hermes` the connections that can be adopted
    // (read by SQL only, never imported); `gateway-llm` the aliases an LLM gateway runner calls.
    dependsOn: ['bots', 'gateway-llm', 'runtime-hermes', 'teams'],
    migrations: 'migrations',
  },
  register(ctx) {
    ctx.providers.register('bot.runners', createBotRunnersProvider(ctx));
    // The runtime that answers a bot placed on an LLM gateway runner (P19-10): a loop of model turns and tool calls, with no process. The run job picks it by the runner's kind.
    ctx.providers.register('bot_runtime', createModelRuntime(ctx));
    registerRoutes(ctx);
  },
});
