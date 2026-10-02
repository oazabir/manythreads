import { definePlugin } from '@manythreads/sdk';

/**
 * bots: the identity of a team's bots — one row per `bots/<slug>/BOT.md` of the team repo, rebuilt whenever that
 * file changes (PLAN P5-03; the `repo.committed` loader, the pairing token and the bot actor are P5-04, the runs
 * of P5-07/P5-10 hang off `bot_runs`). docs/plugins/bots.md.
 */
export default definePlugin({
  manifest: {
    name: 'bots',
    version: '0.1.0',
    kind: 'server',
    // `bot_runs` references app.threads, so this namespace must migrate after the channels plugin's
    dependsOn: ['channels'],
    migrations: 'migrations',
  },
  register() {
    // P5-04 registers the loader, the pairing route and the bot actor here; the schema is what P5-03 ships.
  },
});
