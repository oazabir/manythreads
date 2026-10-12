import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  GetBotResponse,
  GetBotPathParams,
  ListBotsResponse,
  ListBotsPathParams,
  botMdPath,
  getBotRoute,
  listBotsRoute,
} from '@manythreads/shared';
import { json, notFound, requireTeam, route } from './http.ts';
import { BOT_COLUMNS, BOT_RUN_COLUMNS, toBotRun, toBotSummary, type BotRow, type BotRunRow } from './rows.ts';

// The roster and the bot page (SPEC §7.5, PLAN P5-05). Both are reads over `bots`; the definition itself stays in the repo, which the
// page fetches through `repo/blob` and saves through `repo/commit` — so a member who is not a lead is refused by the repo writer's own
// guarded-path rule (403) and the page offers a pull request instead of a Save button. Nothing here writes.

async function botRows(tx: PluginTx, teamId: string, slug?: string): Promise<BotRow[]> {
  const res = await tx.query<BotRow>(
    `SELECT ${BOT_COLUMNS} FROM app.bots WHERE team_id = $1${slug === undefined ? '' : ' AND slug = $2'} ORDER BY name, slug`,
    slug === undefined ? [teamId] : [teamId, slug],
  );
  return res.rows;
}

export function registerBotRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listBotsRoute,
    schema: { response: ListBotsResponse },
    handler: route(async (req, tx) => {
      const { slug } = ListBotsPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      // the route's response schema validates what leaves; the invalid reason is the row's own `invalid_reason` (the loader sets and clears it)
      const bots = (await botRows(tx, team.id)).map(toBotSummary);
      return json({ bots });
    }),
  });

  ctx.http.route({
    ...getBotRoute,
    schema: { response: GetBotResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = GetBotPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const row = (await botRows(tx, team.id, botSlug))[0];
      if (!row) throw notFound(`No bot "${botSlug}"`);
      const runs = await tx.query<BotRunRow>(`SELECT ${BOT_RUN_COLUMNS} FROM app.bot_runs WHERE bot_id = $1 ORDER BY id DESC LIMIT 20`, [row.id]);
      return json({ bot: toBotSummary(row), path: botMdPath(row.slug), runs: runs.rows.map(toBotRun) });
    }),
  });
}