import type { PluginContext, PluginTx } from '@manythreads/sdk';
import {
  AddTeamMemberRequest,
  AddTeamMemberResponse,
  GetTeamRosterResponse,
  RemoveTeamMemberResponse,
  SetTeamMemberRoleRequest,
  SetTeamMemberRoleResponse,
  addTeamMemberRoute,
  getTeamRosterRoute,
  removeTeamMemberRoute,
  setTeamMemberRoleRoute,
} from '@manythreads/shared';
import { json, notFound, route, SlugParam, TeamPersonParams } from './http.ts';
import { toRosterMember, type RosterRow } from './rows.ts';
import { requireActive, requireManage, requireTeam, type Deps } from './teams.ts';

export async function rosterRows(tx: PluginTx, teamId: string): Promise<RosterRow[]> {
  const res = await tx.query<RosterRow>('SELECT * FROM app.teams_roster($1)', [teamId]);
  return res.rows;
}

export async function rosterEntry(tx: PluginTx, teamId: string, personId: string) {
  const row = (await rosterRows(tx, teamId)).find((r) => r.person_id === personId);
  if (!row) throw notFound('Not a member of this team');
  return toRosterMember(row);
}

export function registerRosterRoutes(ctx: PluginContext, { emit }: Deps): void {
  ctx.http.route({
    ...getTeamRosterRoute,
    schema: { response: GetTeamRosterResponse },
    handler: route(async (req, tx) => {
      const team = await requireTeam(tx, SlugParam.parse(req.params).slug);
      return json(GetTeamRosterResponse.parse({ members: (await rosterRows(tx, team.id)).map(toRosterMember) }));
    }),
  });

  ctx.http.route({
    ...addTeamMemberRoute,
    schema: { body: AddTeamMemberRequest, response: AddTeamMemberResponse },
    handler: route(async (req, tx) => {
      const { slug } = SlugParam.parse(req.params);
      const body = AddTeamMemberRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      requireActive(team);
      const res = await tx.query<{ added: boolean }>('SELECT * FROM app.teams_add_member($1, $2, $3)', [team.id, body.personId, body.role]);
      const added = res.rows[0]?.added === true;
      if (added) await emit(tx, { type: 'team.member.added', teamId: team.id, personId: body.personId, role: body.role });
      const member = await rosterEntry(tx, team.id, body.personId);
      return json(AddTeamMemberResponse.parse({ member, added }), added ? 201 : 200);
    }),
  });

  ctx.http.route({
    ...setTeamMemberRoleRoute,
    schema: { body: SetTeamMemberRoleRequest, response: SetTeamMemberRoleResponse },
    handler: route(async (req, tx) => {
      const { slug, personId } = TeamPersonParams.parse(req.params);
      const { role } = SetTeamMemberRoleRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      requireActive(team);
      const res = await tx.query<{ previous: string }>('SELECT app.teams_set_member_role($1, $2, $3) AS previous', [team.id, personId, role]);
      const previous = res.rows[0]?.previous;
      const changed = previous !== role;
      if (changed) await emit(tx, { type: 'team.role.changed', teamId: team.id, personId, previousRole: previous, role });
      return json(SetTeamMemberRoleResponse.parse({ member: await rosterEntry(tx, team.id, personId), changed }));
    }),
  });

  // A lead or admin removes anyone; a member may remove themself (the SQL function enforces both).
  ctx.http.route({
    ...removeTeamMemberRoute,
    schema: { response: RemoveTeamMemberResponse },
    handler: route(async (req, tx) => {
      const { slug, personId } = TeamPersonParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      const res = await tx.query<{ removed: boolean; team_role: string | null; tags: string[] }>(
        'SELECT * FROM app.teams_remove_member($1, $2)',
        [team.id, personId],
      );
      const row = res.rows[0];
      if (!row?.removed) throw notFound('Not a member of this team');
      await emit(tx, { type: 'team.member.removed', teamId: team.id, personId, role: row.team_role, tags: row.tags });
      return json(RemoveTeamMemberResponse.parse({ removed: true, tags: row.tags }));
    }),
  });
}
