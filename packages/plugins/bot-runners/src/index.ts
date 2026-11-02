import { definePlugin } from '@manythreads/sdk';
import { createBotRunnersProvider } from './resolve.ts';
import { registerRoutes } from './routes.ts';

export { DEFAULT_PROFILE_RULE, resolveRunner } from './resolve.ts';

/**
 * bot-runners (PLAN P19-02): the catalog of places a bot can run, set up by a workspace admin. A runner is a Hermes gateway (an address and a key), the team's
 * Hermes pod, a Claude Code or Codex pod (later tasks) or the platform's own LLM gateway. The admin says which teams may use each one and which is the default;
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
    extends: ['event.emit', 'provider.bot.runners', 'secret.seal'],
    events: {
      emits: [
        'bot_runner.runner.created',
        'bot_runner.runner.updated',
        'bot_runner.runner.deleted',
        'bot_runner.runner.tested',
        'bot_runner.availability.changed',
        'bot_runner.default.changed',
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
    registerRoutes(ctx);
  },
});
