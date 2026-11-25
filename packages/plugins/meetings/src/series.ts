import { conflict, forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx, type RepoProvider, type RepoWriteChange } from '@manythreads/sdk';
import {
  CreateMeetingSeriesRequest,
  CreateMeetingSeriesResponse,
  MeetingNoteItem,
  MeetingSeriesParams,
  MeetingSeriesResponse,
  MeetingsAppointmentChangedEvent,
  MeetingsSeriesChangedEvent,
  SERIES_DIR,
  SERIES_PLAN_DAYS,
  UpdateMeetingSeriesRequest,
  createMeetingSeriesRoute,
  isSeriesAgendaPath,
  isSeriesSlug,
  stopMeetingSeriesRoute,
  updateMeetingSeriesRoute,
  type MeetingSeries,
  type MeetingSeriesFrequency,
} from '@manythreads/shared';
import { z } from 'zod';
import { asPeople, loadAppointment, span } from './routes-appointments.ts';
import { callerPerson } from './routes.ts';
import { agendaDue, mergeCarried, noteActionItems, openActionItems, renderAgenda, renderReadme } from './series-agenda.ts';
import { slugOf } from './writer.ts';

/*
 * Meeting series (P17-05, docs/plans/meeting-series.md). A series is a meeting of a team's schedule that repeats; each meeting of it is an appointment (P36-04) of
 * the series, and they share one meeting space. The routes read and write as the caller (row level security, migration 0013); the platform's two jobs plan the
 * meetings ahead and write each meeting's agenda page into `meetings/series/<slug>/` of the team repo, carrying over the action items still open.
 */

export const SERIES_PLAN_QUEUE = 'meetings.series-plan';
export const SERIES_AGENDA_QUEUE = 'meetings.series-agenda';
const AgendaPayload = z.object({ seriesId: z.uuid(), workspaceId: z.uuid() });

type SeriesRow = {
  id: string;
  team_id: string;
  team_slug: string | null;
  team_name: string | null;
  title: string;
  slug: string;
  frequency: MeetingSeriesFrequency;
  until_date: string | null;
  time_zone: string;
  status: 'active' | 'stopped';
  space_channel_id: string;
  created_by_person_id: string | null;
  can_edit: boolean;
};

const SERIES_SELECT = `SELECT s.id, s.team_id, t.slug AS team_slug, t.name AS team_name, s.title, s.slug, s.frequency, to_char(s.until_date, 'YYYY-MM-DD') AS until_date,
  s.time_zone, s.status, s.space_channel_id, s.created_by_person_id, app.meeting_series_can_edit(s.id) AS can_edit
  FROM app.meeting_series s LEFT JOIN app.teams t ON t.id = s.team_id`;

const toSeries = (r: SeriesRow): MeetingSeries => ({
  id: r.id,
  team: { id: r.team_id, slug: r.team_slug ?? '', name: r.team_name ?? 'Another team' },
  title: r.title,
  folder: `${SERIES_DIR}/${r.slug}`,
  frequency: r.frequency,
  untilDate: r.until_date,
  timeZone: r.time_zone,
  status: r.status,
  canEdit: r.can_edit,
});

async function loadSeries(tx: PluginTx, id: string): Promise<SeriesRow> {
  const row = (await tx.query<SeriesRow>(`${SERIES_SELECT} WHERE s.id = $1`, [id])).rows[0];
  if (!row) throw notFound('No such meeting series');
  return row;
}

/**
 * Adds the meetings of a series up to `horizon` (always the first one), from the one after its last: each at the first meeting's local time in the series' time zone
 * plus k weeks, 2k weeks or k months (a month counted from the first date, so the 31st is the last day of a shorter month), until its last day. The new meetings get
 * the people of the series' latest meeting. Returns the ids added. As the caller: the maker while making it, the platform later.
 */
export async function planOccurrences(tx: PluginTx, seriesId: string, horizon: Date): Promise<string[]> {
  const added = (
    await tx.query<{ id: string }>(
      `INSERT INTO app.appointments (workspace_id, team_id, space_channel_id, title, agenda, kind, starts_at, ends_at, created_by, created_by_person_id, series_id, occurrence)
       SELECT s.workspace_id, s.team_id, s.space_channel_id, s.title, s.agenda, s.kind, o.starts_at, o.starts_at + make_interval(mins => s.duration_minutes),
              s.created_by, s.created_by_person_id, s.id, o.k
         FROM app.meeting_series s
         CROSS JOIN LATERAL (
           SELECT k, ((s.first_starts_at AT TIME ZONE s.time_zone)
                      + k * CASE s.frequency WHEN 'weekly' THEN interval '7 days' WHEN 'biweekly' THEN interval '14 days' ELSE interval '1 month' END) AT TIME ZONE s.time_zone AS starts_at
             FROM generate_series(coalesce((SELECT max(a.occurrence) + 1 FROM app.appointments a WHERE a.series_id = s.id), 0), 10000) AS k
            LIMIT 60
         ) o
        WHERE s.id = $1 AND s.status = 'active' AND (o.k = 0 OR o.starts_at <= $2::timestamptz)
          AND (s.until_date IS NULL OR (o.starts_at AT TIME ZONE s.time_zone)::date <= s.until_date)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [seriesId, horizon.toISOString()],
    )
  ).rows.map((r) => r.id);
  if (added.length === 0) return added;
  // the people of the latest meeting before these (none for a new series: the route adds them)
  await tx.query(
    `INSERT INTO app.appointment_invitees (appointment_id, person_id)
     SELECT n.id, i.person_id FROM unnest($2::uuid[]) AS n(id)
       CROSS JOIN (SELECT i.person_id FROM app.appointment_invitees i
                    WHERE i.appointment_id = (SELECT a.id FROM app.appointments a WHERE a.series_id = $1 AND NOT (a.id = ANY ($2::uuid[])) ORDER BY a.occurrence DESC LIMIT 1)) i
     ON CONFLICT DO NOTHING`,
    [seriesId, added],
  );
  return added;
}

/** The first of `slug`, `slug-2`, ... that the team's series do not use. */
async function freeSlug(tx: PluginTx, teamId: string, title: string): Promise<string> {
  const base = slugOf(title);
  const taken = new Set(
    (await tx.query<{ slug: string }>("SELECT slug FROM app.meeting_series WHERE team_id = $1 AND (slug = $2 OR slug LIKE $2 || '-%')", [teamId, base])).rows.map((r) => r.slug),
  );
  for (let n = 1; n <= 99; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(slug)) return slug;
  }
  throw conflict('There are too many series with this title on the team. Choose another title.');
}

/** Checks the people added to a series are active members of the workspace who are not guests. */
async function assertInvitable(tx: PluginTx, people: readonly string[]): Promise<void> {
  if (people.length === 0) return;
  const ok = (
    await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.people p JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id
        WHERE p.id = ANY ($1::uuid[]) AND p.workspace_id = app.workspace_id() AND p.status = 'active' AND wm.role <> 'guest'`,
      [people],
    )
  ).rows[0]!.n;
  if (Number(ok) !== people.length) throw invalid('You can only invite active members of this workspace');
}

export function registerSeriesRoutes(ctx: PluginContext): void {
  const changed = (tx: PluginTx, seriesId: string, teamId: string, change: 'created' | 'changed' | 'stopped'): Promise<void> =>
    ctx.audit.emit(
      tx,
      MeetingsSeriesChangedEvent.parse({
        type: 'meetings.series.changed',
        schemaVersion: 1,
        workspaceId: tx.actor.workspaceId,
        teamId,
        seriesId,
        change,
        changedBy: tx.actor.id,
        at: ctx.runtime.now().toISOString(),
      }),
    );
  // the people newly invited are told once, about the series' next meeting (the notifications plugin reads this event)
  const invited = (tx: PluginTx, appointmentId: string, teamId: string, change: 'created' | 'changed', people: readonly string[]): Promise<void> =>
    ctx.audit.emit(
      tx,
      MeetingsAppointmentChangedEvent.parse({
        type: 'meetings.appointment.changed',
        schemaVersion: 1,
        workspaceId: tx.actor.workspaceId,
        teamId,
        appointmentId,
        change,
        invitedPersonIds: people,
        at: ctx.runtime.now().toISOString(),
      }),
    );
  const agendaSoon = (tx: PluginTx, seriesId: string): Promise<string> =>
    ctx.jobs.enqueue(tx, SERIES_AGENDA_QUEUE, { seriesId, workspaceId: tx.actor.workspaceId }, { dedupeKey: `series-agenda:${seriesId}` });

  ctx.http.route({
    ...createMeetingSeriesRoute,
    schema: { body: CreateMeetingSeriesRequest, response: CreateMeetingSeriesResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const body = CreateMeetingSeriesRequest.parse(req.body);
      span(body.startsAt, body.endsAt);
      // the time zone is one Postgres knows, and the last day is not before the first meeting
      const day = await tx
        .query<{ first_day: string }>("SELECT to_char(($1::timestamptz AT TIME ZONE $2), 'YYYY-MM-DD') AS first_day", [body.startsAt, body.timeZone])
        .catch((err: unknown) => {
          if ((err as { code?: string }).code === '22023') throw invalid('This time zone is not known. Reload the page and try again.');
          throw err;
        });
      const firstDay = day.rows[0]!.first_day;
      if (body.untilDate !== null && body.untilDate < firstDay) throw invalid('The series ends before its first meeting');
      if (body.untilDate !== null && Date.parse(body.untilDate) - Date.parse(firstDay) > 3 * 366 * 86_400_000) throw invalid('A series can be planned at most three years ahead');
      const caller = await callerPerson(tx);
      const team = (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1 AND archived_at IS NULL', [slug])).rows[0];
      if (!team) throw forbidden('You cannot see this team');
      const people = [...new Set<string>(body.inviteeIds.filter((p) => p !== caller.personId))];
      // its one meeting space: the maker and the invited (the function checks that the maker is on the team and that everyone may be invited)
      const space = (await tx.query<{ id: string }>('SELECT app.meetings_open_space($1, $2, $3::uuid[]) AS id', [body.title, team.id, people]).catch(asPeople)).rows[0]!.id;
      const seriesSlug = await freeSlug(tx, team.id, body.title);
      if (!isSeriesSlug(seriesSlug)) throw invalid('Choose another title');
      const minutes = Math.round((Date.parse(body.endsAt) - Date.parse(body.startsAt)) / 60_000);
      const id = (
        await tx
          .query<{ id: string }>(
            `INSERT INTO app.meeting_series (workspace_id, team_id, space_channel_id, slug, title, agenda, kind, frequency, time_zone, first_starts_at, duration_minutes, until_date,
                                             created_by, created_by_person_id)
             VALUES (app.workspace_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, app.actor(), app.person_id()) RETURNING id`,
            [team.id, space, seriesSlug, body.title, body.agenda, body.kind, body.frequency, body.timeZone, body.startsAt, minutes, body.untilDate],
          )
          .catch((err: unknown) => {
            if ((err as { code?: string }).code === '23505') throw conflict('Another series with this title was made just now. Try again.');
            throw err;
          })
      ).rows[0]!.id;
      const horizon = new Date(ctx.runtime.now().getTime() + SERIES_PLAN_DAYS * 86_400_000);
      const meetings = await planOccurrences(tx, id, horizon);
      if (people.length > 0) {
        await tx.query(
          'INSERT INTO app.appointment_invitees (appointment_id, person_id) SELECT a, p FROM unnest($1::uuid[]) AS a, unnest($2::uuid[]) AS p ON CONFLICT DO NOTHING',
          [meetings, people],
        );
      }
      const first = (await tx.query<{ id: string }>('SELECT id FROM app.appointments WHERE series_id = $1 ORDER BY occurrence LIMIT 1', [id])).rows[0]!.id;
      await changed(tx, id, team.id, 'created');
      await invited(tx, first, team.id, 'created', people);
      await agendaSoon(tx, id);
      return json(CreateMeetingSeriesResponse.parse({ series: toSeries(await loadSeries(tx, id)), appointment: await loadAppointment(tx, first) }), 201);
    }),
  });

  ctx.http.route({
    ...updateMeetingSeriesRoute,
    schema: { body: UpdateMeetingSeriesRequest, response: MeetingSeriesResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { id } = MeetingSeriesParams.parse(req.params);
      const body = UpdateMeetingSeriesRequest.parse(req.body);
      const seen = await loadSeries(tx, id);
      if (!seen.can_edit) throw forbidden('Only its maker, a team lead or an admin can change this series');
      // two saves at once: the second waits for the first and works from what it left
      await tx.query('SELECT 1 FROM app.meeting_series WHERE id = $1 FOR UPDATE', [id]);
      const s = await loadSeries(tx, id);
      if (s.status === 'stopped') throw conflict('This series has stopped');
      const future = (
        await tx.query<{ id: string }>("SELECT id FROM app.appointments WHERE series_id = $1 AND status = 'scheduled' AND starts_at > now() ORDER BY starts_at, id", [id])
      ).rows.map((r) => r.id);
      if (body.title !== undefined && body.title !== s.title) {
        await tx.query('UPDATE app.meeting_series SET title = $2, updated_at = now() WHERE id = $1', [id, body.title]);
        if (future.length > 0) await tx.query('UPDATE app.appointments SET title = $2, updated_at = now() WHERE id = ANY ($1::uuid[])', [future, body.title]);
        await tx.query("UPDATE app.channels SET purpose = left($2, 250), updated_at = now() WHERE id = $1 AND kind = 'meeting'", [s.space_channel_id, body.title]).catch(() => undefined);
      }
      let added: string[] = [];
      if (body.inviteeIds !== undefined) {
        if (future.length === 0) throw conflict('This series has no meetings left to invite people to');
        const want = [...new Set<string>(body.inviteeIds.filter((p) => p !== s.created_by_person_id))];
        if (want.length > 100) throw invalid('A series invites at most 100 people');
        const had = new Set(
          (await tx.query<{ person_id: string }>('SELECT person_id FROM app.appointment_invitees WHERE appointment_id = $1', [future[0]])).rows.map((r) => r.person_id),
        );
        added = want.filter((p) => !had.has(p));
        await assertInvitable(tx, added);
        await tx.query('DELETE FROM app.appointment_invitees WHERE appointment_id = ANY ($1::uuid[]) AND NOT (person_id = ANY ($2::uuid[]))', [future, want]);
        if (want.length > 0) {
          await tx.query(
            'INSERT INTO app.appointment_invitees (appointment_id, person_id) SELECT a, p FROM unnest($1::uuid[]) AS a, unnest($2::uuid[]) AS p ON CONFLICT DO NOTHING',
            [future, want],
          );
        }
        // the space's members follow the meetings to come (its maker stays)
        await tx.query('SELECT app.appointment_sync_space($1)', [future[0]]);
      }
      await changed(tx, id, s.team_id, 'changed');
      if (added.length > 0) await invited(tx, future[0]!, s.team_id, 'changed', added);
      return json(MeetingSeriesResponse.parse({ series: toSeries(await loadSeries(tx, id)) }));
    }),
  });

  ctx.http.route({
    ...stopMeetingSeriesRoute,
    schema: { response: MeetingSeriesResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { id } = MeetingSeriesParams.parse(req.params);
      const seen = await loadSeries(tx, id);
      if (!seen.can_edit) throw forbidden('Only its maker, a team lead or an admin can stop this series');
      await tx.query('SELECT 1 FROM app.meeting_series WHERE id = $1 FOR UPDATE', [id]);
      const s = await loadSeries(tx, id);
      if (s.status === 'stopped') throw conflict('This series has already stopped');
      await tx.query("UPDATE app.meeting_series SET status = 'stopped', stopped_at = now(), updated_at = now() WHERE id = $1", [id]);
      // the meetings still to come are cancelled; one under way and the past ones stay, with their agendas
      await tx.query("UPDATE app.appointments SET status = 'cancelled', updated_at = now() WHERE series_id = $1 AND status = 'scheduled' AND starts_at > now()", [id]);
      await changed(tx, id, s.team_id, 'stopped');
      return json(MeetingSeriesResponse.parse({ series: toSeries(await loadSeries(tx, id)) }));
    }),
  });
}

type Occurrence = { id: string; occurrence: number; starts_at: Date; ends_at: Date; status: 'scheduled' | 'cancelled'; agenda_path: string | null; day: string; day_label: string };

/** A folded day label in English ("Tuesday 1 December 2026") and the date, in the series' time zone. */
const OCCURRENCE_SELECT = `SELECT a.id, a.occurrence, a.starts_at, a.ends_at, a.status, a.agenda_path,
  to_char(a.starts_at AT TIME ZONE s.time_zone, 'YYYY-MM-DD') AS day, to_char(a.starts_at AT TIME ZONE s.time_zone, 'FMDay FMDD FMMonth YYYY') AS day_label
  FROM app.appointments a JOIN app.meeting_series s ON s.id = a.series_id`;

/** The open action items to carry into the next agenda: the last agenda's unticked boxes and the last call's written notes (never a Personal copy). */
async function carriedItems(ctx: PluginContext, tx: PluginTx, teamId: string, spaceId: string, previous: Occurrence | undefined): Promise<string[]> {
  if (!previous) return [];
  let fromAgenda: string[] = [];
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (repo && previous.agenda_path && isSeriesAgendaPath(previous.agenda_path)) {
    const blob = await repo.blob(tx, teamId, previous.agenda_path, 'main').catch((err: unknown) => {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    });
    if (blob) fromAgenda = openActionItems(Buffer.from(blob.content).toString('utf8'));
  }
  const notes = (
    await tx.query<{ items: unknown }>(
      `SELECT n.items FROM app.meetings m JOIN app.meeting_notes n ON n.meeting_id = m.id
        WHERE m.channel_id = $1 AND m.state = 'ended' AND m.started_at >= $2::timestamptz - interval '30 minutes'
          AND n.status = 'written' AND n.location <> 'personal'
        ORDER BY m.started_at DESC LIMIT 1`,
      [spaceId, previous.starts_at.toISOString()],
    )
  ).rows[0];
  const items = z.array(MeetingNoteItem).safeParse(notes?.items ?? []);
  return mergeCarried(fromAgenda, items.success ? noteActionItems(items.data) : []);
}

/**
 * Writes the agenda that is due for a series, if one is: the README of its folder with the first one, and the carried items. One commit as the platform. Returns
 * the path written, or null. Exported for the tests; the job reaches it through `meetings.series-agenda`.
 */
export async function writeDueAgenda(ctx: PluginContext, tx: PluginTx, seriesId: string): Promise<string | null> {
  const s = (
    await tx.query<{ id: string; team_id: string; team_name: string; slug: string; title: string; agenda: string; frequency: MeetingSeriesFrequency; until_date: string | null; status: string; space_channel_id: string }>(
      `SELECT s.id, s.team_id, t.name AS team_name, s.slug, s.title, s.agenda, s.frequency, to_char(s.until_date, 'YYYY-MM-DD') AS until_date, s.status, s.space_channel_id
         FROM app.meeting_series s JOIN app.teams t ON t.id = s.team_id WHERE s.id = $1 FOR UPDATE OF s`,
      [seriesId],
    )
  ).rows[0];
  if (!s || s.status !== 'active' || !isSeriesSlug(s.slug)) return null;
  const now = ctx.runtime.now();
  const target = (
    await tx.query<Occurrence>(`${OCCURRENCE_SELECT} WHERE a.series_id = $1 AND a.status = 'scheduled' AND a.agenda_path IS NULL AND a.ends_at > $2 ORDER BY a.starts_at, a.id LIMIT 1`, [
      seriesId,
      now.toISOString(),
    ])
  ).rows[0];
  if (!target) return null;
  // the meeting held before it (a cancelled one was not held) and the last agenda written before it
  const before = (
    await tx.query<Occurrence>(`${OCCURRENCE_SELECT} WHERE a.series_id = $1 AND a.status = 'scheduled' AND a.starts_at < $2 ORDER BY a.starts_at DESC, a.id DESC LIMIT 1`, [seriesId, target.starts_at])
  ).rows[0];
  const lastAgenda = (
    await tx.query<Occurrence>(`${OCCURRENCE_SELECT} WHERE a.series_id = $1 AND a.agenda_path IS NOT NULL AND a.starts_at < $2 ORDER BY a.starts_at DESC, a.id DESC LIMIT 1`, [seriesId, target.starts_at])
  ).rows[0];
  const live = (await tx.query("SELECT 1 FROM app.meetings WHERE channel_id = $1 AND state = 'live' LIMIT 1", [s.space_channel_id])).rows.length > 0;
  if (!agendaDue({ previousEndsAt: before?.ends_at ?? null, startsAt: target.starts_at, now, callLive: live })) return null;

  // a meeting moved onto a day another one already uses gets `-2`
  const used = new Set((await tx.query<{ agenda_path: string }>('SELECT agenda_path FROM app.appointments WHERE series_id = $1 AND agenda_path IS NOT NULL', [seriesId])).rows.map((r) => r.agenda_path));
  const folder = `${SERIES_DIR}/${s.slug}`;
  let path = `${folder}/${target.day}-agenda.md`;
  for (let n = 2; used.has(path) && n <= 99; n += 1) path = `${folder}/${target.day}-agenda-${n}.md`;
  if (used.has(path) || !isSeriesAgendaPath(path)) return null;

  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('The team repo is not available');
  const carried = await carriedItems(ctx, tx, s.team_id, s.space_channel_id, lastAgenda);
  const changes: RepoWriteChange[] = [{ path, op: 'put', content: renderAgenda({ title: s.title, dateLabel: target.day_label, carried, agendaLine: s.agenda }) }];
  if (used.size === 0) {
    const readme = `${folder}/README.md`;
    const exists = await repo.blob(tx, s.team_id, readme, 'main').then(
      () => true,
      () => false,
    );
    if (!exists) changes.push({ path: readme, op: 'put', content: renderReadme({ title: s.title, teamName: s.team_name, frequency: s.frequency, untilDate: s.until_date }) });
  }
  await repo.write(tx, s.team_id, { id: tx.actor.id, kind: 'system' }, changes, `Agenda: ${s.title.slice(0, 100)} · ${target.day}`);
  await tx.query('UPDATE app.appointments SET agenda_path = $2, agenda_written_at = now() WHERE id = $1', [target.id, path]);
  return path;
}

/** One pass of the planner: every active series gets its meetings for the next 92 days, and the agenda job for each series whose next agenda is due. */
export async function seriesPlanPass(ctx: PluginContext, tx: PluginTx): Promise<{ added: number; agendas: number }> {
  const horizon = new Date(ctx.runtime.now().getTime() + SERIES_PLAN_DAYS * 86_400_000);
  const series = (await tx.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM app.meeting_series WHERE status = 'active' ORDER BY id LIMIT 5000")).rows;
  let added = 0;
  let agendas = 0;
  for (const s of series) {
    // a change of its people or a stop holds the same lock: a new meeting never copies the people from before the change, nor lands after the stop
    const locked = (await tx.query("SELECT 1 FROM app.meeting_series WHERE id = $1 AND status = 'active' FOR UPDATE", [s.id])).rows.length;
    if (locked === 0) continue;
    added += (await planOccurrences(tx, s.id, horizon)).length;
    // the next meeting without an agenda, when the one before it ended an hour ago (or it starts within the hour): the job checks again, with the call
    const due = (
      await tx.query(
        `WITH next AS (SELECT a.series_id, a.starts_at FROM app.appointments a
                        WHERE a.series_id = $1 AND a.status = 'scheduled' AND a.agenda_path IS NULL AND a.ends_at > now() ORDER BY a.starts_at LIMIT 1)
         SELECT 1 FROM next WHERE next.starts_at <= now() + interval '1 hour'
             OR NOT EXISTS (SELECT 1 FROM app.appointments b WHERE b.series_id = next.series_id AND b.status = 'scheduled' AND b.starts_at < next.starts_at
                                                              AND b.ends_at + interval '1 hour' > now())`,
        [s.id],
      )
    ).rows.length;
    if (due > 0) {
      await ctx.jobs.enqueue(tx, SERIES_AGENDA_QUEUE, { seriesId: s.id, workspaceId: s.workspace_id }, { dedupeKey: `series-agenda:${s.id}` });
      agendas += 1;
    }
  }
  return { added, agendas };
}

export function registerSeriesJobs(ctx: PluginContext): void {
  ctx.jobs.register(
    SERIES_PLAN_QUEUE,
    async (_payload, tx) => {
      await seriesPlanPass(ctx, tx);
    },
    { cron: '*/10 * * * *', maxAttempts: 1, concurrency: 1 },
  );
  ctx.jobs.register(
    SERIES_AGENDA_QUEUE,
    async (payload, tx) => {
      const p = AgendaPayload.parse(payload);
      await writeDueAgenda(ctx, tx, p.seriesId);
    },
    { serialKey: 'seriesId', maxAttempts: 5 },
  );
}
