import { forbidden, json, notFound, requireTeam, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  BotUsagePathParams,
  BotUsageResponse,
  TeamUsagePathParams,
  TeamUsageResponse,
  UsageQuery,
  WorkspaceUsageResponse,
  botUsageRoute,
  teamUsageRoute,
  workspaceUsageRoute,
} from '@manythreads/shared';
import { aliasesOf, botRowsOf, budgetOf, dailyOf, namesOf, qualityOf, readSeries, signInsOf, teamRowsOf, totalsOf, usageRange } from './usage.ts';

// The usage pages' three reads. They run as the signed-in person, so the table's row level security decides what there is to add up (a member reads the
// teams they belong to, an admin the workspace, a guest nothing); the code only decides who may SEE money, and says so in the answer (null, not zero).

async function roleOf(tx: PluginTx): Promise<string | null> {
  return (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role ?? null;
}
const isAdmin = (role: string | null): boolean => role === 'owner' || role === 'admin';

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    method: workspaceUsageRoute.method,
    path: workspaceUsageRoute.path,
    readOnly: true,
    schema: { query: UsageQuery, response: WorkspaceUsageResponse },
    handler: route(async (req, tx) => {
      if (!isAdmin(await roleOf(tx))) throw forbidden('Only workspace admins can see the workspace usage.');
      const { days } = UsageQuery.parse(req.query ?? {});
      const now = ctx.runtime.now();
      const range = usageRange(now, days);
      const workspaceId = tx.actor.workspaceId;
      const rows = await readSeries(tx, workspaceId, range, now);
      const names = await namesOf(
        tx,
        rows.map((r) => r.bot_id).filter((id): id is string => id !== null),
        rows.map((r) => r.team_id).filter((id): id is string => id !== null),
      );
      return json(
        WorkspaceUsageResponse.parse({
          range,
          totals: totalsOf(rows, true),
          daily: dailyOf(rows, range, true),
          spendByAlias: aliasesOf(rows, true),
          quality: qualityOf(rows),
          budget: await budgetOf(tx, workspaceId, 'workspace', null, now),
          generatedAt: now.toISOString(),
          teams: teamRowsOf(rows, names, true),
          bots: botRowsOf(rows, names, true),
          signIns: signInsOf(rows),
        }),
      );
    }),
  });

  ctx.http.route({
    method: teamUsageRoute.method,
    path: teamUsageRoute.path,
    readOnly: true,
    schema: { query: UsageQuery, response: TeamUsageResponse },
    handler: route(async (req, tx) => {
      const { slug } = TeamUsagePathParams.parse(req.params);
      const { days } = UsageQuery.parse(req.query ?? {});
      const team = await requireTeam(tx, slug);
      const teamRow = (await tx.query<{ slug: string; name: string }>('SELECT slug, name FROM app.teams WHERE id = $1', [team.id])).rows[0];
      if (!teamRow) throw notFound(`No team "${slug}"`);
      const money = isAdmin(await roleOf(tx));
      const now = ctx.runtime.now();
      const range = usageRange(now, days);
      const rows = await readSeries(tx, team.workspace_id, range, now, { teamId: team.id });
      const names = await namesOf(tx, rows.map((r) => r.bot_id).filter((id): id is string => id !== null), [team.id]);
      // "Brain quality" is the quality of the team's Brain; a team without one gets the quality of all its answers
      const brain = (await tx.query<{ id: string; slug: string }>(`SELECT id, slug FROM app.bots WHERE team_id = $1 AND slug = 'brain'`, [team.id])).rows[0];
      const qualityRows = brain ? rows.filter((r) => r.bot_id === brain.id) : rows;
      return json(
        TeamUsageResponse.parse({
          range,
          totals: totalsOf(rows, money),
          daily: dailyOf(rows, range, money),
          spendByAlias: aliasesOf(rows, money),
          quality: qualityOf(qualityRows),
          budget: money ? await budgetOf(tx, team.workspace_id, 'team', team.id, now) : null,
          generatedAt: now.toISOString(),
          team: { id: team.id, slug: teamRow.slug, name: teamRow.name },
          bots: botRowsOf(rows, names, money),
          brainSlug: brain?.slug ?? null,
        }),
      );
    }),
  });

  ctx.http.route({
    method: botUsageRoute.method,
    path: botUsageRoute.path,
    readOnly: true,
    schema: { query: UsageQuery, response: BotUsageResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotUsagePathParams.parse(req.params);
      const { days } = UsageQuery.parse(req.query ?? {});
      const team = await requireTeam(tx, slug);
      const teamRow = (await tx.query<{ slug: string; name: string }>('SELECT slug, name FROM app.teams WHERE id = $1', [team.id])).rows[0];
      const bot = (await tx.query<{ id: string; slug: string; name: string }>('SELECT id, slug, name FROM app.bots WHERE team_id = $1 AND slug = $2', [team.id, botSlug])).rows[0];
      // an unknown bot and one of another team answer the same, so a probe learns nothing
      if (!teamRow || !bot) throw notFound(`No bot "${botSlug}"`);
      const money = isAdmin(await roleOf(tx));
      const now = ctx.runtime.now();
      const range = usageRange(now, days);
      const rows = await readSeries(tx, team.workspace_id, range, now, { botId: bot.id });
      return json(
        BotUsageResponse.parse({
          range,
          totals: totalsOf(rows, money),
          daily: dailyOf(rows, range, money),
          spendByAlias: aliasesOf(rows, money),
          quality: qualityOf(rows),
          budget: money ? await budgetOf(tx, team.workspace_id, 'bot', bot.id, now) : null,
          generatedAt: now.toISOString(),
          team: { id: team.id, slug: teamRow.slug, name: teamRow.name },
          bot: { id: bot.id, slug: bot.slug, name: bot.name },
        }),
      );
    }),
  });
}
