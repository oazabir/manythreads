import type { PluginContext } from '@manythreads/sdk';
import { BotEvalsPathParams, GetBotEvalsResponse, RunEvalsRequest, RunEvalsResponse, getBotEvalsRoute, runEvalsRoute } from '@manythreads/shared';
import { EVAL_QUEUE, EVAL_RUN_COLUMNS, toEvalRun, type EvalRunRow } from './evals.ts';
import { conflict, json, notFound, requireManage, requireTeam, route } from './http.ts';

// A bot's evals over HTTP (PLAN P7-08): any member who can read the team reads the latest runs; a lead or workspace admin starts one.
// The route only records the request (one row, `running`) and queues the job: the run itself is evals.ts.

/** A second run is refused while one started this recently is still open. An older open run is a dead one (the hourly pass ends it). */
const OPEN_RUN_MINUTES = 10;

export function registerEvalRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...getBotEvalsRoute,
    schema: { response: GetBotEvalsResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotEvalsPathParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const bot = (await tx.query<{ id: string }>('SELECT id FROM app.bots WHERE team_id = $1 AND slug = $2', [team.id, botSlug])).rows[0];
      if (!bot) throw notFound(`No bot "${botSlug}"`);
      const recent = (
        await tx.query<EvalRunRow>(`SELECT ${EVAL_RUN_COLUMNS} FROM app.bot_eval_runs WHERE bot_id = $1 ORDER BY id DESC LIMIT 10`, [bot.id])
      ).rows;
      const latest = (
        await tx.query<EvalRunRow>(
          `SELECT ${EVAL_RUN_COLUMNS} FROM app.bot_eval_runs WHERE bot_id = $1 AND status IN ('finished', 'failed') ORDER BY id DESC LIMIT 1`,
          [bot.id],
        )
      ).rows[0];
      // a run that has not read BOT.md yet (or whose BOT.md named no set) carries the placeholder name "-": it says nothing about the set
      const newest = recent.find((r) => r.set_name !== '-');
      const canRun = (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'manage') AS ok", [team.id])).rows[0]?.ok === true;
      return json({
        set: newest ? { name: newest.set_name, minScore: newest.min_score } : null,
        latest: latest ? toEvalRun(latest) : null,
        recent: recent.map((r) => toEvalRun(r, false)),
        canRun,
      });
    }),
  });

  ctx.http.route({
    ...runEvalsRoute,
    rateLimit: { limit: 20, windowMs: 60_000 },
    schema: { response: RunEvalsResponse },
    handler: route(async (req, tx) => {
      const { slug, botSlug } = BotEvalsPathParams.parse(req.params);
      const { mode } = RunEvalsRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const bot = (await tx.query<{ id: string; status: string }>('SELECT id, status FROM app.bots WHERE team_id = $1 AND slug = $2', [team.id, botSlug])).rows[0];
      if (!bot) throw notFound(`No bot "${botSlug}"`);
      // Two requests at once must not both see "nothing open": take turns on the bot until this transaction ends. The check below reads after the
      // lock is held, so it sees the other request's committed row.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`bots.eval-run:${bot.id}`]);
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM app.bot_eval_runs WHERE bot_id = $1 AND status = 'running' AND started_at > now() - make_interval(mins => $2) LIMIT 1`,
        [bot.id, OPEN_RUN_MINUTES],
      );
      if (open.rows.length > 0) throw conflict('A run of this bot\'s evals is already in progress. Wait for it to finish.');
      // the set name and minimum are placeholders until the job reads BOT.md at the head of main and fills them in
      const inserted = await tx.query<EvalRunRow>(
        `INSERT INTO app.bot_eval_runs (workspace_id, team_id, bot_id, bot_slug, set_name, trigger, mode, requested_by)
         VALUES ($1, $2, $3, $4, '-', 'on_demand', $5, $6) RETURNING ${EVAL_RUN_COLUMNS}`,
        [team.workspace_id, team.id, bot.id, botSlug, mode, tx.actor.id],
      );
      const row = inserted.rows[0]!;
      await ctx.jobs.enqueue(tx, EVAL_QUEUE, {
        workspaceId: team.workspace_id,
        teamId: team.id,
        botSlug,
        serial: `${team.id}:${botSlug}`,
        trigger: 'on_demand',
        mode,
        runId: row.id,
        commitSha: null,
      });
      return json({ run: toEvalRun(row) }, 202);
    }),
  });
}
