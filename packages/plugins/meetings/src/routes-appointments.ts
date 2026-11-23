import { conflict, forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  AppointmentParams,
  AppointmentResponse,
  CreateAppointmentRequest,
  ListAppointmentsQuery,
  ListAppointmentsResponse,
  MeetingsAppointmentChangedEvent,
  MeetingsAppointmentStartingSoonEvent,
  UpdateAppointmentRequest,
  cancelAppointmentRoute,
  joinAppointmentRoute,
  OpenMeetingSpaceResponse,
  createAppointmentRoute,
  listAppointmentsRoute,
  updateAppointmentRoute,
  type Appointment,
} from '@manythreads/shared';
import { callerPerson, startRoom } from './routes.ts';
import { loadMeeting, toMeeting } from './rows.ts';

/*
 * The team schedule (P36-04, docs/plans/team-schedule.md). Every route reads as the caller: a member of a team sees its appointments, an invited person of
 * another team sees the ones they are invited to (row level security, migration 0010). Making one opens its meeting space (P36-03) with the invited as its
 * members, in the same transaction; changing the invited changes the space's members.
 */

type Row = {
  id: string;
  team_id: string;
  team_slug: string | null;
  team_name: string | null;
  title: string;
  agenda: string;
  kind: 'audio' | 'video';
  starts_at: Date;
  ends_at: Date;
  status: 'scheduled' | 'cancelled';
  space_channel_id: string;
  created_by_person_id: string | null;
  maker_name: string | null;
  live: string | null;
  can_edit: boolean;
};

const SELECT = `SELECT a.id, a.team_id, t.slug AS team_slug, t.name AS team_name, a.title, a.agenda, a.kind, a.starts_at, a.ends_at, a.status, a.space_channel_id,
  a.created_by_person_id, (SELECT p.display_name FROM app.people p WHERE p.id = a.created_by_person_id) AS maker_name,
  (SELECT m.id FROM app.meetings m WHERE m.channel_id = a.space_channel_id AND m.state = 'live' LIMIT 1) AS live,
  app.appointment_can_edit(a.id) AS can_edit
  FROM app.appointments a LEFT JOIN app.teams t ON t.id = a.team_id`;

async function shape(tx: PluginTx, rows: Row[]): Promise<Appointment[]> {
  if (rows.length === 0) return [];
  const invited = (
    await tx.query<{ appointment_id: string; person_id: string; name: string }>(
      `SELECT i.appointment_id, i.person_id, coalesce(p.display_name, 'Someone') AS name FROM app.appointment_invitees i LEFT JOIN app.people p ON p.id = i.person_id
        WHERE i.appointment_id = ANY ($1::uuid[]) ORDER BY p.display_name`,
      [rows.map((r) => r.id)],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    // a person invited from another team does not see that team's row: its name is said plainly
    team: { id: r.team_id, slug: r.team_slug ?? '', name: r.team_name ?? 'Another team' },
    title: r.title,
    agenda: r.agenda,
    kind: r.kind,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    status: r.status,
    channelId: r.space_channel_id as Appointment['channelId'],
    createdBy: r.created_by_person_id ? { personId: r.created_by_person_id as Appointment['invited'][number]['personId'], name: r.maker_name ?? 'Someone' } : null,
    invited: invited.filter((i) => i.appointment_id === r.id).map((i) => ({ personId: i.person_id as Appointment['invited'][number]['personId'], name: i.name })),
    liveMeetingId: (r.live as Appointment['liveMeetingId']) ?? null,
    canEdit: r.can_edit,
  }));
}

async function loadOne(tx: PluginTx, id: string): Promise<Appointment> {
  const row = (await tx.query<Row>(`${SELECT} WHERE a.id = $1`, [id])).rows[0];
  if (!row) throw notFound('No such appointment');
  return (await shape(tx, [row]))[0]!;
}

const span = (startsAt: string, endsAt: string): void => {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!(end > start)) throw invalid('An appointment ends after it starts');
  if (end - start > 24 * 3600_000) throw invalid('An appointment lasts at most 24 hours');
};

const asPeople = (err: unknown): never => {
  const code = (err as { code?: string }).code;
  const message = err instanceof Error ? err.message : '';
  if (code === '42501') throw forbidden(message.includes('team') ? 'Make an appointment for a team you are on' : 'You cannot make an appointment here');
  if (code === '22023') throw invalid(message.charAt(0).toUpperCase() + message.slice(1));
  throw err;
};

export function registerAppointmentRoutes(ctx: PluginContext): void {
  const changed = (tx: PluginTx, appointmentId: string, teamId: string, change: 'created' | 'changed' | 'cancelled', invited: readonly string[]): Promise<void> =>
    ctx.audit.emit(
      tx,
      MeetingsAppointmentChangedEvent.parse({
        type: 'meetings.appointment.changed',
        schemaVersion: 1,
        workspaceId: tx.actor.workspaceId,
        teamId,
        appointmentId,
        change,
        invitedPersonIds: invited,
        at: ctx.runtime.now().toISOString(),
      }),
    );
  ctx.http.route({
    ...listAppointmentsRoute,
    schema: { response: ListAppointmentsResponse },
    handler: route(async (req, tx) => {
      const { from, to } = ListAppointmentsQuery.parse(req.query);
      if (Date.parse(to) - Date.parse(from) > 62 * 24 * 3600_000) throw invalid('Ask for at most two months at a time');
      const rows = (await tx.query<Row>(`${SELECT} WHERE a.starts_at < $2::timestamptz AND a.ends_at > $1::timestamptz ORDER BY a.starts_at, a.id LIMIT 500`, [from, to])).rows;
      return json(ListAppointmentsResponse.parse({ appointments: await shape(tx, rows) }));
    }),
  });

  ctx.http.route({
    ...createAppointmentRoute,
    schema: { body: CreateAppointmentRequest, response: AppointmentResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const body = CreateAppointmentRequest.parse(req.body);
      span(body.startsAt, body.endsAt);
      const caller = await callerPerson(tx);
      const team = (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1 AND archived_at IS NULL', [slug])).rows[0];
      if (!team) throw forbidden('You cannot see this team');
      const invitees = [...new Set(body.inviteeIds.filter((p) => p !== caller.personId))];
      // its meeting space: the maker and the invited (the function checks that the maker is on the team and that everyone may be invited)
      const space = (await tx.query<{ id: string }>('SELECT app.meetings_open_space($1, $2, $3::uuid[]) AS id', [body.title, team.id, invitees]).catch(asPeople)).rows[0]!.id;
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.appointments (workspace_id, team_id, space_channel_id, title, agenda, kind, starts_at, ends_at, created_by, created_by_person_id)
           VALUES (app.workspace_id(), $1, $2, $3, $4, $5, $6, $7, app.actor(), app.person_id()) RETURNING id`,
          [team.id, space, body.title, body.agenda, body.kind, body.startsAt, body.endsAt],
        )
      ).rows[0]!.id;
      for (const p of invitees) await tx.query('INSERT INTO app.appointment_invitees (appointment_id, person_id) VALUES ($1, $2)', [id, p]);
      await changed(tx, id, team.id, 'created', invitees);
      return json(AppointmentResponse.parse({ appointment: await loadOne(tx, id) }), 201);
    }),
  });

  ctx.http.route({
    ...updateAppointmentRoute,
    schema: { body: UpdateAppointmentRequest, response: AppointmentResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { id } = AppointmentParams.parse(req.params);
      const body = UpdateAppointmentRequest.parse(req.body);
      const before = await loadOne(tx, id);
      if (!before.canEdit) throw forbidden('Only its maker, a team lead or an admin can change this appointment');
      if (before.status === 'cancelled') throw conflict('This appointment is cancelled');
      span(body.startsAt ?? before.startsAt, body.endsAt ?? before.endsAt);
      const moved = (body.startsAt !== undefined && body.startsAt !== before.startsAt) || (body.endsAt !== undefined && body.endsAt !== before.endsAt);
      await tx.query(
        `UPDATE app.appointments SET title = coalesce($2, title), agenda = coalesce($3, agenda), kind = coalesce($4, kind), starts_at = coalesce($5::timestamptz, starts_at),
                ends_at = coalesce($6::timestamptz, ends_at), reminded_at = CASE WHEN $7::boolean THEN NULL ELSE reminded_at END, updated_at = now()
          WHERE id = $1`,
        [id, body.title ?? null, body.agenda ?? null, body.kind ?? null, body.startsAt ?? null, body.endsAt ?? null, moved],
      );
      let added: string[] = [];
      if (body.inviteeIds) {
        const want = new Set<string>(body.inviteeIds.filter((p) => p !== before.createdBy?.personId));
        const had = new Set(before.invited.map((i) => i.personId as string));
        added = [...want].filter((p) => !had.has(p));
        const removed = [...had].filter((p) => !want.has(p));
        if (want.size > 100) throw invalid('An appointment invites at most 100 people');
        if (added.length > 0) {
          // the people added must be active members of the workspace who are not guests, as when it was made
          const ok = (
            await tx.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM app.people p JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
                WHERE p.id = ANY ($1::uuid[]) AND p.workspace_id = app.workspace_id() AND p.status = 'active' AND wm.role <> 'guest'`,
              [added],
            )
          ).rows[0]!.n;
          if (Number(ok) !== added.length) throw invalid('You can only invite active members of this workspace');
        }
        for (const p of added) await tx.query('INSERT INTO app.appointment_invitees (appointment_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, p]);
        if (removed.length > 0) await tx.query('DELETE FROM app.appointment_invitees WHERE appointment_id = $1 AND person_id = ANY ($2::uuid[])', [id, removed]);
        await tx.query('SELECT app.appointment_sync_space($1)', [id]);
      }
      if (body.title) await tx.query("UPDATE app.channels SET purpose = left($2, 250), updated_at = now() WHERE id = $1 AND kind = 'meeting'", [before.channelId, body.title]).catch(() => undefined);
      await changed(tx, id, before.team.id, 'changed', added);
      return json(AppointmentResponse.parse({ appointment: await loadOne(tx, id) }));
    }),
  });

  ctx.http.route({
    ...joinAppointmentRoute,
    schema: { response: OpenMeetingSpaceResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { id } = AppointmentParams.parse(req.params);
      const a = await loadOne(tx, id);
      if (a.status === 'cancelled') throw conflict('This appointment is cancelled');
      const caller = await callerPerson(tx);
      // only the people of its space (the maker and the invited) can be in its call; a member of the team who is not invited sees it but is not in it
      const member = (await tx.query<{ ok: boolean }>("SELECT coalesce(app.lookup_channel_can($1::uuid, 'post'), false) AS ok", [a.channelId])).rows[0]?.ok === true;
      if (!member) throw forbidden('Only the people invited can join this meeting. Ask its maker to invite you.');
      const { m, created, join, invited } = await startRoom(ctx, tx, { channelId: a.channelId, title: a.title, caller, kind: a.kind });
      const fresh = (await loadMeeting(tx, m.id)) ?? m;
      return json(OpenMeetingSpaceResponse.parse({ meeting: toMeeting(fresh), created, join, invited, channelId: a.channelId }));
    }),
  });

  ctx.http.route({
    ...cancelAppointmentRoute,
    schema: { response: AppointmentResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { id } = AppointmentParams.parse(req.params);
      const before = await loadOne(tx, id);
      if (!before.canEdit) throw forbidden('Only its maker, a team lead or an admin can cancel this appointment');
      if (before.status === 'cancelled') throw conflict('This appointment is already cancelled');
      await tx.query("UPDATE app.appointments SET status = 'cancelled', updated_at = now() WHERE id = $1", [id]);
      await changed(tx, id, before.team.id, 'cancelled', []);
      return json(AppointmentResponse.parse({ appointment: await loadOne(tx, id) }));
    }),
  });
}

/** One pass of the reminder (P36-07): every appointment that starts within five minutes and was not reminded is said once to its maker and its invited. */
export async function appointmentReminderPass(ctx: PluginContext): Promise<number> {
  return ctx.db.system(async (tx) => {
    const due = (
      await tx.query<{ id: string; workspace_id: string; space_channel_id: string; people: string[] }>(
        `UPDATE app.appointments a SET reminded_at = now()
          WHERE a.status = 'scheduled' AND a.reminded_at IS NULL AND a.starts_at > now() AND a.starts_at <= now() + interval '5 minutes'
          RETURNING a.id, a.workspace_id, a.space_channel_id,
                    array_remove(array_append(ARRAY(SELECT i.person_id FROM app.appointment_invitees i WHERE i.appointment_id = a.id), a.created_by_person_id), NULL) AS people`,
      )
    ).rows;
    for (const r of due) {
      await ctx.audit.emit(
        tx,
        MeetingsAppointmentStartingSoonEvent.parse({
          type: 'meetings.appointment.starting_soon',
          schemaVersion: 1,
          workspaceId: r.workspace_id,
          appointmentId: r.id,
          channelId: r.space_channel_id,
          personIds: r.people,
          at: ctx.runtime.now().toISOString(),
        }),
      );
    }
    return due.length;
  });
}

export function registerAppointmentReminder(ctx: PluginContext): void {
  ctx.jobs.register(
    'meetings.appointment-reminders',
    async () => {
      await appointmentReminderPass(ctx);
    },
    { cron: '* * * * *', maxAttempts: 1, concurrency: 1, detached: true },
  );
}
