import { definePlugin } from '@manythreads/sdk';
import { registerBackfillJob } from './backfill.ts';
import { registerBotLoader } from './loader.ts';
import { registerPairingRoutes } from './routes.ts';
import { registerBotRoutes } from './roster.ts';

export { BACKFILL_QUEUE, backfillModelAliases, modelAliasesOf } from './backfill.ts';
export { hashPairingToken, mintPairingToken, newPairingToken, resolvePairingToken, revokePairingTokens } from './pairing.ts';
export type { PairedBot } from './pairing.ts';

/**
 * bots: the identity of a team's bots — one row per `bots/<slug>/BOT.md` of the team repo (docs/plugins/bots.md). The loader (a
 * `repo.repo.committed` subscription: rebuild the row, the bot actor and the compiled `mayTag` grant; alert on a definition that will
 * not load; drop the row when the file is gone), the pairing routes and the resolve door the runtimes of P5-09/P5-10 use, and the
 * roster/bot-page reads the web client draws (P5-05). The runs themselves hang off `bot_runs` (P5-07).
 */
export default definePlugin({
  manifest: {
    name: 'bots',
    version: '0.4.0',
    kind: 'server',
    // `bot_runs` references app.threads, so this namespace must migrate after the channels plugin's
    dependsOn: ['channels'],
    migrations: 'migrations',
    extends: ['event.subscribe', 'event.emit', 'job.register'],
    events: {
      emits: ['bots.bot.loaded', 'bots.bot.invalid', 'bots.bot.removed'],
      consumes: ['repo.repo.committed'],
    },
  },
  register(ctx) {
    registerBotLoader(ctx);
    registerBackfillJob(ctx);
    registerPairingRoutes(ctx);
    registerBotRoutes(ctx);
  },
});
