import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  GetBotResponse,
  GetBotPathParams,
  ListBotsResponse,
  ListBotsPathParams,
  BotsBotInvalidEvent,
  botMdPath,
  getBotRoute,
  listBotsRoute,
  parseEvent,
  type BotSummary,
} from '@manythreads/shared';
import { json, notFound, requireTeam, route } from './http.ts';
import { BOT_COLUMNS, BOT_RUN_COLUMNS, toBotRun, toBotSummary, type BotRow, type BotRunRow } from './rows.ts';

// The roster and the bot page (SPEC §7.5, PLAN P5-05). Both are reads over `bots`; the definition itself stays in the repo, which the
// page fetches through `repo/blob` and saves through `repo/commit` — so a member who is not a lead is refused by the repo writer's own
// guarded-path rule (403) and the page offers a pull request instead of a Save button. Nothing here writes.

/** The newest `bots.bot.invalid` for each bot of the team: the alert the page's red banner shows (PLAN P5-04 keeps no error column). */
async function invalidReasons(tx: PluginTx, teamId: string): Promise<Map<string, BotSummary['invalid']>> {
  const res = await tx.query<{ occurred_at: Date; type: string; schema_version: number; workspace_id: string; payload: Record<string, unknown> }>(
    `SELECT occurred_at, type, schema_version, workspace_id, payload FROM app.events
      WHERE team_id = $1 AND type = 'bots.bot.invalid'
      ORDER BY id DESC
      LIMIT 200`,
    [teamId],
  );
  const out = new Map<string, BotSummary['invalid']>();
  for (const row of res.rows) {
    // Rebuild the event the way the outbox does (a plugin cannot import the kernel's `eventToRaw`): the payload's fields sit at the
    // top level next to the envelope, then validate. `parseEvent` throws on an envelope it does not know, so this must not be reached
    // with a shaped-wrong row; the type filter keeps it to events this plugin wrote.
    const event = BotsBotInvalidEvent.safeParse(parseEvent({ ...row.payload, type: row.type, schemaVersion: row.schema_version, workspaceId: row.workspace_id }));
    if (!event.success || event.data.botId === null) continue;
    // newest first, so the first row that names a bot is the one it shows; an older failure is history
    if (out.has(event.data.botId)) continue;
    out.set(event.data.botId, {
      fieldPath: event.data.fieldPath,
      message: event.data.message,
      at: row.occurred_at.toISOString(),
      definitionSha: event.data.definitionSha,
    });
  }
  return out;
}

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
      const invalid = await invalidReasons(tx, team.id);
      const bots = (await botRows(tx, team.id)).map((r) => toBotSummary(r, invalid.get(r.id) ?? null));
      return json(ListBotsResponse.parse({ bots }));
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
      const invalid = await invalidReasons(tx, team.id);
      const runs = await tx.query<BotRunRow>(`SELECT ${BOT_RUN_COLUMNS} FROM app.bot_runs WHERE bot_id = $1 ORDER BY id DESC LIMIT 20`, [row.id]);
      return json(GetBotResponse.parse({ bot: toBotSummary(row, invalid.get(row.id) ?? null), path: botMdPath(row.slug), runs: runs.rows.map(toBotRun) }));
    }),
  });
}