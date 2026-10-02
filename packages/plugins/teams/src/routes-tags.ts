import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  AssignTeamTagResponse,
  CreateTeamTagRequest,
  CreateTeamTagResponse,
  DeleteTeamTagResponse,
  ListTeamTagsResponse,
  RoleTagName,
  TeamTag,
  UnassignTeamTagResponse,
  assignTeamTagRoute,
  createTeamTagRoute,
  deleteTeamTagRoute,
  listTeamTagsRoute,
  unassignTeamTagRoute,
} from '@manythreads/shared';
import { HttpError, json, notFound, route, SlugParam, TeamPersonTagParams, TeamTagParams } from './http.ts';
import { rosterRows } from './routes-roster.ts';
import { requireActive, requireManage, requireTeam, type Deps } from './teams.ts';

const tagName = (raw: string): string => {
  const parsed = RoleTagName.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "tag: role tag like 'role:on-call'");
  return parsed.data;
};

/** The team's tags (the mirror of TEAM.md roleTags) with the roster members who hold each. */
async function teamTags(tx: PluginTx, teamId: string): Promise<TeamTag[]> {
  const defined = await tx.query<{ role_id: string; name: string }>(
    `SELECT r.id AS role_id, r.name FROM app.team_role_tags trt JOIN app.roles r ON r.id = trt.role_id
     WHERE trt.team_id = $1 ORDER BY r.name`,
    [teamId],
  );
  const roster = await rosterRows(tx, teamId);
  return defined.rows.map((t) =>
    TeamTag.parse({
      name: t.name,
      roleId: t.role_id,
      holders: roster.filter((m) => m.tags.includes(t.name)).map((m) => m.person_id),
    }),
  );
}

async function oneTag(tx: PluginTx, teamId: string, name: string): Promise<TeamTag> {
  const tag = (await teamTags(tx, teamId)).find((t) => t.name === name);
  if (!tag) throw notFound(`The team has no tag ${name}`);
  return tag;
}

export function registerTagRoutes(ctx: PluginContext, { emit }: Deps): void {
  ctx.http.route({
    ...listTeamTagsRoute,
    schema: { response: ListTeamTagsResponse },
    handler: route(async (req, tx) => {
      const team = await requireTeam(tx, SlugParam.parse(req.params).slug);
      return json(ListTeamTagsResponse.parse({ tags: await teamTags(tx, team.id) }));
    }),
  });

  ctx.http.route({
    ...createTeamTagRoute,
    schema: { body: CreateTeamTagRequest, response: CreateTeamTagResponse },
    handler: route(async (req, tx) => {
      const { slug } = SlugParam.parse(req.params);
      const { name } = CreateTeamTagRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      requireActive(team);
      const res = await tx.query<{ role_id: string; created: boolean }>('SELECT * FROM app.teams_tag_define($1, $2)', [team.id, name]);
      const row = res.rows[0];
      if (!row) throw new Error('teams_tag_define returned nothing');
      if (row.created) await emit(tx, { type: 'team.tag.created', teamId: team.id, tag: name, roleId: row.role_id });
      return json(CreateTeamTagResponse.parse({ tag: await oneTag(tx, team.id, name), created: row.created }), row.created ? 201 : 200);
    }),
  });

  ctx.http.route({
    ...deleteTeamTagRoute,
    schema: { response: DeleteTeamTagResponse },
    handler: route(async (req, tx) => {
      const params = TeamTagParams.parse(req.params);
      const name = tagName(params.tag);
      const team = await requireTeam(tx, params.slug);
      await requireManage(tx, team);
      requireActive(team);
      const res = await tx.query<{ deleted: boolean; removed_from: string[] }>('SELECT * FROM app.teams_tag_drop($1, $2)', [team.id, name]);
      const row = res.rows[0];
      if (!row?.deleted) throw notFound(`The team has no tag ${name}`);
      await emit(tx, { type: 'team.tag.deleted', teamId: team.id, tag: name, removedFrom: row.removed_from });
      return json(DeleteTeamTagResponse.parse({ deleted: true, removedFrom: row.removed_from }));
    }),
  });

  ctx.http.route({
    ...assignTeamTagRoute,
    schema: { response: AssignTeamTagResponse },
    handler: route(async (req, tx) => {
      const params = TeamPersonTagParams.parse(req.params);
      const name = tagName(params.tag);
      const team = await requireTeam(tx, params.slug);
      await requireManage(tx, team);
      requireActive(team);
      const res = await tx.query<{ role_id: string; defined: boolean; assigned: boolean }>(
        'SELECT * FROM app.teams_tag_assign($1, $2, $3)',
        [team.id, params.personId, name],
      );
      const row = res.rows[0];
      if (!row) throw new Error('teams_tag_assign returned nothing');
      if (row.defined) await emit(tx, { type: 'team.tag.created', teamId: team.id, tag: name, roleId: row.role_id });
      if (row.assigned) await emit(tx, { type: 'team.tag.assigned', teamId: team.id, personId: params.personId, tag: name });
      return json(AssignTeamTagResponse.parse({ tag: await oneTag(tx, team.id, name), assigned: row.assigned }));
    }),
  });

  ctx.http.route({
    ...unassignTeamTagRoute,
    schema: { response: UnassignTeamTagResponse },
    handler: route(async (req, tx) => {
      const params = TeamPersonTagParams.parse(req.params);
      const name = tagName(params.tag);
      const team = await requireTeam(tx, params.slug);
      await requireManage(tx, team);
      requireActive(team);
      const res = await tx.query<{ removed: boolean }>('SELECT app.teams_tag_unassign($1, $2, $3) AS removed', [team.id, params.personId, name]);
      const removed = res.rows[0]?.removed === true;
      if (removed) await emit(tx, { type: 'team.tag.removed', teamId: team.id, personId: params.personId, tag: name });
      return json(UnassignTeamTagResponse.parse({ removed }));
    }),
  });
}
