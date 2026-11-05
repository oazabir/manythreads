import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  CreateScheduledJobRequest,
  CreateScheduledJobResponse,
  ListScheduledJobRunsResponse,
  ListScheduledJobsResponse,
  RunScheduledJobResponse,
  UpdateScheduledJobRequest,
  UpdateScheduledJobResponse,
  createScheduledJobRoute,
  listScheduledJobRunsRoute,
  listScheduledJobsRoute,
  parseCron,
  runScheduledJobRoute,
  updateScheduledJobRoute,
} from '@manythreads/shared';
import { conflict, invalid, json, notFound, requireManage, requireTeam, route } from '@manythreads/sdk';
import { nextRunFor, startScheduledJobRun } from './scheduler.ts';
import { toScheduledJob, toScheduledJobRun, type ScheduledJobRow, type ScheduledJobRunRow } from './rows.ts';

/** The bot this team may schedule: by id or slug, and it must be one of the team's own. */
async function resolveBot(tx: PluginTx, teamId: string, botId?: string, botSlug?: string): Promise<string> {
  const row = (
    await tx.query<{ id: string }>(
      `SELECT b.id FROM app.bots b
        WHERE b.team_id = $1::uuid
          AND (($2::uuid IS NOT NULL AND b.id = $2::uuid) OR ($3::text IS NOT NULL AND b.slug = $3::text))`,
      [teamId, botId ?? null, botSlug ?? null],
    )
  ).rows[0];
  if (!row) throw notFound('No such bot in this team');
  return row.id;
}

export function registerRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listScheduledJobsRoute,
    schema: { response: ListScheduledJobsResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const rows = (await tx.query<ScheduledJobRow>('SELECT * FROM app.scheduled_jobs WHERE team_id = $1::uuid ORDER BY created_at', [team.id])).rows;
      return json(ListScheduledJobsResponse.parse({ items: rows.map(toScheduledJob) }));
    }),
  });

  ctx.http.route({
    ...createScheduledJobRoute,
    schema: { body: CreateScheduledJobRequest, response: CreateScheduledJobResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = CreateScheduledJobRequest.parse(req.body);
      const botId = await resolveBot(tx, team.id, body.botId, body.botSlug);
      try {
        parseCron(body.schedule);
      } catch (err) {
        throw invalid(err instanceof Error ? err.message : 'invalid schedule');
      }
      if (body.kind === 'routine' && !body.contractPath?.startsWith('routines/')) throw invalid('a routine contract lives under routines/');
      if (body.outputPath !== null && !body.outputPath.startsWith('pages/')) throw invalid('a page output lives under pages/');
      const next = nextRunFor(body.schedule, new Date());
      if (body.enabled && next === null) throw invalid('this schedule never fires');
      const row = (
        await tx.query<ScheduledJobRow>(
          `INSERT INTO app.scheduled_jobs (workspace_id, team_id, bot_id, name, kind, schedule, model_alias, effort, contract_path, output_path, enabled, next_run_at, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid)
           RETURNING *`,
          [
            team.workspace_id,
            team.id,
            botId,
            body.name,
            body.kind,
            body.schedule,
            body.modelAlias,
            body.effort,
            body.contractPath,
            body.outputPath,
            body.enabled,
            next,
            tx.actor.id,
          ],
        )
      ).rows[0];
      if (!row) throw conflict('Could not create the scheduled job');
      return json(CreateScheduledJobResponse.parse({ scheduledJob: toScheduledJob(row) }), 201);
    }),
  });

  ctx.http.route({
    ...updateScheduledJobRoute,
    schema: { body: UpdateScheduledJobRequest, response: UpdateScheduledJobResponse },
    handler: route(async (req, tx) => {
      const { slug, scheduledJobId } = req.params as { slug: string; scheduledJobId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const body = UpdateScheduledJobRequest.parse(req.body ?? {});
      const existing = (await tx.query<ScheduledJobRow>('SELECT * FROM app.scheduled_jobs WHERE id = $1::uuid AND team_id = $2::uuid', [scheduledJobId, team.id])).rows[0];
      if (!existing) throw notFound('No such scheduled job');
      if (body.schedule !== undefined) {
        try {
          parseCron(body.schedule);
        } catch (err) {
          throw invalid(err instanceof Error ? err.message : 'invalid schedule');
        }
      }
      if (body.contractPath !== undefined && body.contractPath !== null && !body.contractPath.startsWith('routines/')) throw invalid('a routine contract lives under routines/');
      if (body.outputPath !== undefined && body.outputPath !== null && !body.outputPath.startsWith('pages/')) throw invalid('a page output lives under pages/');
      const schedule = body.schedule ?? existing.schedule;
      const enabled = body.enabled ?? existing.enabled;
      const kind = existing.kind;
      if (enabled && kind === 'routine' && (body.contractPath ?? existing.contract_path) === null) throw invalid('a routine needs a contract path');
      const next = enabled ? nextRunFor(schedule, new Date()) : null;
      if (enabled && next === null) throw invalid('this schedule never fires');
      const row = (
        await tx.query<ScheduledJobRow>(
          `UPDATE app.scheduled_jobs
              SET name = coalesce($3, name), schedule = $4, model_alias = coalesce($5, model_alias),
                  effort = coalesce($6, effort), contract_path = coalesce($7, contract_path),
                  output_path = coalesce($8, output_path), enabled = $9, next_run_at = $10, updated_at = now()
            WHERE id = $1::uuid AND team_id = $2::uuid
            RETURNING *`,
          [
            scheduledJobId,
            team.id,
            body.name ?? null,
            schedule,
            body.modelAlias === undefined ? null : body.modelAlias,
            body.effort === undefined ? null : body.effort,
            body.contractPath === undefined ? null : body.contractPath,
            body.outputPath === undefined ? null : body.outputPath,
            enabled,
            next,
          ],
        )
      ).rows[0];
      if (!row) throw notFound('No such scheduled job');
      return json(UpdateScheduledJobResponse.parse({ scheduledJob: toScheduledJob(row) }));
    }),
  });

  ctx.http.route({
    ...listScheduledJobRunsRoute,
    schema: { response: ListScheduledJobRunsResponse },
    handler: route(async (req, tx) => {
      const { slug, scheduledJobId } = req.params as { slug: string; scheduledJobId: string };
      const team = await requireTeam(tx, slug);
      const scheduledJob = (await tx.query('SELECT 1 FROM app.scheduled_jobs WHERE id = $1::uuid AND team_id = $2::uuid', [scheduledJobId, team.id])).rows[0];
      if (!scheduledJob) throw notFound('No such scheduledJob');
      const rows = (
        await tx.query<ScheduledJobRunRow>('SELECT * FROM app.scheduled_job_runs WHERE scheduled_job_id = $1::uuid ORDER BY id DESC LIMIT 50', [scheduledJobId])
      ).rows;
      return json(ListScheduledJobRunsResponse.parse({ items: rows.map(toScheduledJobRun) }));
    }),
  });

  ctx.http.route({
    ...runScheduledJobRoute,
    rateLimit: { limit: 30, windowMs: 60_000 },
    schema: { response: RunScheduledJobResponse },
    handler: route(async (req, tx) => {
      const { slug, scheduledJobId } = req.params as { slug: string; scheduledJobId: string };
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const scheduledJob = (await tx.query<ScheduledJobRow>('SELECT * FROM app.scheduled_jobs WHERE id = $1::uuid AND team_id = $2::uuid', [scheduledJobId, team.id])).rows[0];
      if (!scheduledJob) throw notFound('No such scheduledJob');
      const started = await startScheduledJobRun(ctx, tx, scheduledJob, new Date());
      return json(RunScheduledJobResponse.parse({ run: toScheduledJobRun(started.run) }), 202);
    }),
  });
}
