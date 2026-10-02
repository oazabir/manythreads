import type { PluginContext } from '@manythreads/sdk';
import {
  ApplyTeamTemplateRequest,
  ApplyTeamTemplateResponse,
  ArchiveTeamResponse,
  CreateTeamRequest,
  CreateTeamResponse,
  GetTeamResponse,
  ListTeamsQuery,
  ListTeamsResponse,
  RenameTeamRequest,
  RenameTeamResponse,
  UnarchiveTeamResponse,
  applyTeamTemplateRoute,
  archiveTeamRoute,
  createTeamRoute,
  getTeamRoute,
  listTeamsRoute,
  renameTeamRoute,
  unarchiveTeamRoute,
} from '@manythreads/shared';
import { conflict, json, notFound, route, SlugParam } from './http.ts';
import { TEAM_WITH_COUNTS, toTeamDetail, toTeamSummary, type TeamRow } from './rows.ts';
import {
  getOrCreateTeam,
  requireActive,
  requireManage,
  requireTeam,
  slugFor,
  teamById,
  type Deps,
} from './teams.ts';

export function registerTeamRoutes(ctx: PluginContext, { emit, templates }: Deps): void {
  // Only the teams the caller can see: row level security does the filtering, not this query.
  ctx.http.route({
    ...listTeamsRoute,
    schema: { query: ListTeamsQuery, response: ListTeamsResponse },
    handler: route(async (req, tx) => {
      const { includeArchived } = ListTeamsQuery.parse(req.query);
      const res = await tx.query<TeamRow>(
        `SELECT ${TEAM_WITH_COUNTS} FROM app.teams t WHERE ($1::boolean OR t.archived_at IS NULL) ORDER BY lower(t.name), t.id`,
        [includeArchived === 'true'],
      );
      return json(ListTeamsResponse.parse({ teams: res.rows.map(toTeamSummary) }));
    }),
  });

  ctx.http.route({
    ...getTeamRoute,
    schema: { response: GetTeamResponse },
    handler: route(async (req, tx) => {
      const team = await requireTeam(tx, SlugParam.parse(req.params).slug);
      return json(GetTeamResponse.parse({ team: toTeamDetail(team) }));
    }),
  });

  ctx.http.route({
    ...createTeamRoute,
    schema: { body: CreateTeamRequest, response: CreateTeamResponse },
    handler: route(async (req, tx) => {
      const body = CreateTeamRequest.parse(req.body);
      const slug = slugFor(body.name, body.slug);
      const { team, created } = await getOrCreateTeam(tx, { name: body.name, slug, template: null });
      if (!created) throw conflict(`A team with the slug "${slug}" already exists`);
      await emit(tx, { type: 'workspace.team.created', teamId: team.id, slug: team.slug, name: team.name, template: null });
      return json(CreateTeamResponse.parse({ team: toTeamDetail(team) }), 201);
    }),
  });

  ctx.http.route({
    ...applyTeamTemplateRoute,
    schema: { body: ApplyTeamTemplateRequest, response: ApplyTeamTemplateResponse },
    handler: route(async (req, tx) => {
      const body = ApplyTeamTemplateRequest.parse(req.body);
      const template = templates.find((t) => t.id === body.templateId);
      if (!template) throw notFound(`No team template "${body.templateId}"`);
      const name = body.name ?? template.name;
      const slug = slugFor(name, body.slug);
      const { team, created } = await getOrCreateTeam(tx, { name, slug, template });
      if (!created) {
        // Applying the same template for the same slug again is a no-op that returns the team; another template or a
        // hand-made team on that slug is a different thing and must not be overwritten.
        if (team.template !== template.id) throw conflict(`A team with the slug "${slug}" already exists`);
        return json(ApplyTeamTemplateResponse.parse({ team: toTeamDetail(team), created: false }));
      }
      await emit(tx, { type: 'workspace.team.created', teamId: team.id, slug: team.slug, name: team.name, template: template.id });
      await emit(tx, {
        type: 'team.template.applied',
        teamId: team.id,
        slug: team.slug,
        templateId: template.id,
        templateVersion: template.version,
      });
      return json(ApplyTeamTemplateResponse.parse({ team: toTeamDetail(team), created: true }), 201);
    }),
  });

  ctx.http.route({
    ...renameTeamRoute,
    schema: { body: RenameTeamRequest, response: RenameTeamResponse },
    handler: route(async (req, tx) => {
      const { slug } = SlugParam.parse(req.params);
      const { name } = RenameTeamRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      requireActive(team);
      if (team.name === name) return json(RenameTeamResponse.parse({ team: toTeamDetail(team) }));
      await tx.query('UPDATE app.teams SET name = $2, updated_at = now() WHERE id = $1', [team.id, name]);
      await emit(tx, { type: 'workspace.team.renamed', teamId: team.id, previousName: team.name, name });
      return json(RenameTeamResponse.parse({ team: toTeamDetail(await teamById(tx, team.id)) }));
    }),
  });

  ctx.http.route({
    ...archiveTeamRoute,
    schema: { response: ArchiveTeamResponse },
    handler: route(async (req, tx) => {
      const team = await requireTeam(tx, SlugParam.parse(req.params).slug);
      await requireManage(tx, team);
      const res = await tx.query(
        'UPDATE app.teams SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id',
        [team.id],
      );
      const changed = res.rows.length > 0;
      if (changed) await emit(tx, { type: 'workspace.team.archived', teamId: team.id });
      return json(ArchiveTeamResponse.parse({ team: toTeamDetail(await teamById(tx, team.id)), changed }));
    }),
  });

  ctx.http.route({
    ...unarchiveTeamRoute,
    schema: { response: UnarchiveTeamResponse },
    handler: route(async (req, tx) => {
      const team = await requireTeam(tx, SlugParam.parse(req.params).slug);
      await requireManage(tx, team);
      const res = await tx.query(
        'UPDATE app.teams SET archived_at = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL RETURNING id',
        [team.id],
      );
      const changed = res.rows.length > 0;
      if (changed) await emit(tx, { type: 'workspace.team.unarchived', teamId: team.id });
      return json(UnarchiveTeamResponse.parse({ team: toTeamDetail(await teamById(tx, team.id)), changed }));
    }),
  });
}
