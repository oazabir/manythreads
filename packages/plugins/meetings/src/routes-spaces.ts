import { conflict, forbidden, invalid, json, route, type PluginContext } from '@manythreads/sdk';
import { ListMeetingSpacesResponse, MeetingPeopleQuery, MeetingPeopleResponse, OpenMeetingSpaceRequest, OpenMeetingSpaceResponse, listMeetingSpacesRoute, meetingPeopleRoute, openMeetingSpaceRoute } from '@manythreads/shared';
import { callerPerson, startRoom } from './routes.ts';
import { loadMeeting, toMeeting } from './rows.ts';

/*
 * Meetings without a channel (P36-03, docs/plans/meetings-without-a-channel.md). Opening a meeting makes its space (a team-less private channel of kind
 * `meeting` whose members are the opener and the invited, from any team; `app.meetings_open_space` checks who may) and starts its call there at once, with
 * the invitations of any call. The list is the spaces the person is in, newest first, with the call live in each.
 */

export function registerMeetingSpaceRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...openMeetingSpaceRoute,
    schema: { body: OpenMeetingSpaceRequest, response: OpenMeetingSpaceResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const body = OpenMeetingSpaceRequest.parse(req.body);
      const caller = await callerPerson(tx);
      const team = (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1 AND archived_at IS NULL', [body.teamSlug])).rows[0];
      if (!team) throw forbidden('You cannot see this team');
      const channelId = (
        await tx
          .query<{ id: string }>('SELECT app.meetings_open_space($1, $2, $3::uuid[]) AS id', [body.title, team.id, body.inviteeIds.filter((p) => p !== caller.personId)])
          .catch((err: unknown) => {
            const code = (err as { code?: string }).code;
            const message = err instanceof Error ? err.message : '';
            if (code === '42501') throw forbidden(message.includes('team') ? 'Open a meeting for a team you are on' : 'Only members of the workspace can open a meeting');
            if (code === '22023') throw invalid(message.charAt(0).toUpperCase() + message.slice(1));
            throw err;
          })
      ).rows[0]!.id;
      const { m, created, join, invited } = await startRoom(ctx, tx, {
        channelId,
        title: body.title,
        caller,
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.inviteeIds.length > 0 ? { inviteeIds: body.inviteeIds.filter((p) => p !== caller.personId) } : {}),
      });
      if (!created) throw conflict('The meeting could not start');
      const fresh = (await loadMeeting(tx, m.id)) ?? m;
      return json(OpenMeetingSpaceResponse.parse({ meeting: toMeeting(fresh), created, join, invited, channelId }), 201);
    }),
  });

  ctx.http.route({
    ...listMeetingSpacesRoute,
    schema: { response: ListMeetingSpacesResponse },
    handler: route(async (_req, tx) => {
      const rows = (
        await tx.query<{ channel_id: string; title: string; team_id: string | null; created_at: Date; members: number; live: string | null }>(
          `SELECT c.id AS channel_id, c.purpose AS title, s.team_id, c.created_at,
                  (SELECT count(*)::int FROM app.channel_members cm WHERE cm.channel_id = c.id) AS members,
                  (SELECT m.id FROM app.meetings m WHERE m.channel_id = c.id AND m.state = 'live' LIMIT 1) AS live
             FROM app.channels c LEFT JOIN app.meeting_spaces s ON s.channel_id = c.id
            WHERE c.kind = 'meeting' AND c.archived_at IS NULL
            ORDER BY c.created_at DESC LIMIT 50`,
        )
      ).rows;
      return json(
        ListMeetingSpacesResponse.parse({
          spaces: rows.map((r) => ({ channelId: r.channel_id, title: r.title, teamId: r.team_id, createdAt: r.created_at.toISOString(), memberCount: r.members, liveMeetingId: r.live })),
        }),
      );
    }),
  });

  ctx.http.route({
    ...meetingPeopleRoute,
    schema: { response: MeetingPeopleResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { q } = MeetingPeopleQuery.parse(req.query);
      await callerPerson(tx);
      const rows = (
        await tx.query<{ person_id: string; name: string }>(
          `SELECT p.id AS person_id, p.display_name AS name
             FROM app.people p JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
            WHERE p.workspace_id = app.workspace_id() AND p.status = 'active' AND wm.role <> 'guest' AND p.id <> app.person_id()
              AND ($1 = '' OR p.display_name ILIKE '%' || replace(replace($1, '%', ''), '_', '') || '%')
            ORDER BY p.display_name LIMIT 50`,
          [q],
        )
      ).rows;
      return json(MeetingPeopleResponse.parse({ people: rows.map((r) => ({ personId: r.person_id, name: r.name })) }));
    }),
  });
}
