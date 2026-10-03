import { definePlugin } from '@manythreads/sdk';
import { registerBotLoader } from './loader.ts';
import { registerPairingRoutes } from './routes.ts';

export { hashPairingToken, mintPairingToken, newPairingToken, resolvePairingToken, revokePairingTokens } from './pairing.ts';
export type { PairedBot } from './pairing.ts';

/**
 * bots: the identity of a team's bots — one row per `bots/<slug>/BOT.md` of the team repo (docs/plugins/bots.md). P5-04 adds the loader
 * (a `repo.repo.committed` subscription: rebuild the row, the bot actor and the compiled `mayTag` grant; alert on a definition that
 * will not load; drop the row when the file is gone), the pairing routes and the resolve door the runtimes of P5-09/P5-10 use; the
 * runs themselves hang off `bot_runs` (P5-07).
 */
export default definePlugin({
  manifest: {
    name: 'bots',
    version: '0.2.0',
    kind: 'server',
    // `bot_runs` references app.threads, so this namespace must migrate after the channels plugin's
    dependsOn: ['channels'],
    migrations: 'migrations',
    extends: ['event.subscribe', 'event.emit'],
    events: {
      emits: ['bots.bot.loaded', 'bots.bot.invalid', 'bots.bot.removed'],
      consumes: ['repo.repo.committed'],
    },
  },
  register(ctx) {
    registerBotLoader(ctx);
    registerPairingRoutes(ctx);
  },
});
