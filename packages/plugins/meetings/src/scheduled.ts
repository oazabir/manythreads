import {
  HttpError,
  conflict,
  forbidden,
  invalid,
  notFound,
  type CalendarConnector,
  type ConnectorResult,
  type PluginContext,
  type PluginEvent,
  type PluginTx,
} from '@manythreads/sdk';
import {
  ChannelChannelArchivedEvent,
  MeetingsScheduledCancelledEvent,
  MeetingsScheduledChangedEvent,
  MeetingsScheduledCreatedEvent,
  SCHEDULED_AGENDA_MAX,
  SCHEDULED_MEETING_CHANGED_PUSH,
  ScheduledMeeting,
  ScheduledMeetingChangedPush,
  type CreateScheduledMeetingRequest,
  type ScheduledMeetingGate,
  type UpdateScheduledMeetingRequest,
} from '@manythreads/shared';
import type { Caller } from './routes.ts';

// Work package C (P16-05, decisions D4 to D9): planning a room ahead. The service functions behind `routes-scheduled.ts` and the jobs: make the event at the organizer's own calendar
// (`connector.calendar`, looked up when needed, never in `register`), write the plan with `app.meetings_schedule`, map invited addresses to people (D6), cancel with
// `app.meetings_cancel_scheduled`, and cancel the plans of a channel that is archived. Outside addresses are used for the invitation and forgotten: only their number is kept.
//
//   * The person's own click is the consent for the calendar write (D4): no approval card. The event is made first (its description carries the join link, which names the plan's id),
//     then the plan; if the plan cannot be written the event is taken away again.
//   * A plan changes only through its organizer (here) or the platform's jobs (`scheduled-jobs.ts`). The row's columns are written as the system role after the organizer was checked,
//     because the table has no policy that lets a person write it.
//   * What a calendar says (a title, a description) is outside text: it is stored as data, shown as text, and fenced when a model reads it.

/** Cancels the calendar event of a plan that was cancelled by the platform (an archived channel); a person's own cancel does it in the request. */
export const SCHEDULED_CANCEL_EVENT_QUEUE = 'meetings.scheduled-cancel-event';
/** Re-reads the calendar event of a plan whose room just opened, so the Scribe is told the agenda as it is at that moment (D9). */
export const SCHEDULED_AGENDA_QUEUE = 'meetings.scheduled-agenda';

export type ScheduledRow = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  channel_id: string;
  organizer_id: string;
  provider: 'google' | 'microsoft';
  calendar_id: string | null;
  external_event_id: string | null;
  title: string;
  starts_at: Date;
  ends_at: Date;
  agenda_md: string;
  status: 'scheduled' | 'cancelled' | 'started';
  outside_count: number;
  reminded_at: Date | null;
  synced_at: Date | null;
  created_at: Date;
  organizer_name: string | null;
  attendee_ids: string[];
  meeting_id: string | null;
};

const COLUMNS = `s.id, s.workspace_id, s.team_id, s.channel_id, s.organizer_id, s.provider, s.calendar_id, s.external_event_id, s.title, s.starts_at, s.ends_at, s.agenda_md, s.status,
  s.outside_count, s.reminded_at, s.synced_at, s.created_at,
  (SELECT p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id WHERE a.id = s.organizer_id AND a.kind = 'person') AS organizer_name,
  coalesce((SELECT array_agg(x.person_id ORDER BY x.person_id) FROM app.scheduled_meeting_attendees x WHERE x.scheduled_meeting_id = s.id), ARRAY[]::uuid[]) AS attendee_ids,
  (SELECT m.id FROM app.meetings m WHERE m.scheduled_meeting_id = s.id ORDER BY m.started_at DESC, m.id DESC LIMIT 1) AS meeting_id`;

export const toScheduled = (row: ScheduledRow): ScheduledMeeting =>
  ScheduledMeeting.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    channelId: row.channel_id,
    title: row.title,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    agendaMd: row.agenda_md,
    status: row.status,
    provider: row.provider,
    organizerId: row.organizer_id,
    organizerName: row.organizer_name,
    attendeeCount: row.attendee_ids.length,
    outsideCount: row.outside_count,
    attendeePersonIds: row.attendee_ids,
    meetingId: row.meeting_id,
    joinPath: `/join/${row.id}`,
    createdAt: row.created_at.toISOString(),
  });

export async function loadScheduled(tx: PluginTx, id: string): Promise<ScheduledRow | null> {
  return (await tx.query<ScheduledRow>(`SELECT ${COLUMNS} FROM app.scheduled_meetings s WHERE s.id = $1::uuid`, [id])).rows[0] ?? null;
}

/** Waiting plans of a channel soonest first, or (`upcoming`) the one the header chip shows: a plan whose room is live, else the next that starts within 12 hours. */
export async function listScheduled(tx: PluginTx, channelId: string, opts: { upcoming: boolean; limit: number }): Promise<ScheduledRow[]> {
  if (opts.upcoming) {
    return (
      await tx.query<ScheduledRow>(
        `SELECT ${COLUMNS} FROM app.scheduled_meetings s
          WHERE s.channel_id = $1::uuid
            AND ((s.status = 'scheduled' AND s.ends_at > now() AND s.starts_at <= now() + interval '12 hours')
                 OR (s.status = 'started' AND EXISTS (SELECT 1 FROM app.meetings m WHERE m.scheduled_meeting_id = s.id AND m.state = 'live')))
          ORDER BY (s.status = 'started') DESC, s.starts_at, s.id LIMIT 1`,
        [channelId],
      )
    ).rows;
  }
  return (
    await tx.query<ScheduledRow>(
      `SELECT ${COLUMNS} FROM app.scheduled_meetings s WHERE s.channel_id = $1::uuid AND s.status = 'scheduled' AND s.ends_at > now() ORDER BY s.starts_at, s.id LIMIT $2::int`,
      [channelId, opts.limit],
    )
  ).rows;
}

/** What `/join/:id` needs for the caller, who may not read the channel: the state of the plan and two names, never its title or agenda. Null: no such plan in this workspace. */
export async function scheduledGate(tx: PluginTx, id: string): Promise<ScheduledMeetingGate | null> {
  const row = (await tx.query<{ readable: boolean; status: ScheduledRow['status']; channel_name: string | null; organizer_name: string | null }>('SELECT * FROM app.meetings_scheduled_gate($1::uuid)', [id])).rows[0];
  return row ? { readable: row.readable, status: row.status, channelName: row.channel_name, organizerName: row.organizer_name } : null;
}

// ---- words ------------------------------------------------------------------------------------------------------------------------------------------------------

/** The address that opens a plan. */
export const joinUrl = (ctx: PluginContext, id: string): string => `${ctx.runtime.publicUrl.replace(/\/+$/, '')}/join/${id}`;

/** The text of the calendar event: the agenda, then the join link on a line of its own. */
export function eventDescription(agenda: string, link: string): string {
  const a = agenda.trim();
  return `${a === '' ? '' : `${a}\n\n`}Join: ${link}`;
}

/** Tags removed (no regular expression over the text), for a description a calendar returned as HTML. */
function stripTags(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (inTag) {
      if (ch === '>') inTag = false;
    } else if (ch === '<') {
      inTag = true;
      out += '\n';
    } else out += ch;
  }
  return out.replaceAll('&nbsp;', ' ').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

/** A description as one comparable text: line ends and blank runs made the same, tags removed. */
export function normalizeText(text: string): string {
  const plain = text.includes('<') ? stripTags(text) : text;
  return plain
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The agenda in a description a calendar returned: the text without our "Join: <link>" line. */
export function agendaFromDescription(description: string, link: string): string {
  return normalizeText(
    normalizeText(description)
      .split('\n')
      .filter((l) => l.trim() !== `Join: ${link}`)
      .join('\n'),
  ).slice(0, SCHEDULED_AGENDA_MAX);
}

// ---- the calendar's answers ---------------------------------------------------------------------------------------------------------------------------------

/** A refusal of the calendar door as the person should read it. The messages are ours: the provider's own words never get this far. */
export function calendarFailure(result: Extract<ConnectorResult<unknown>, { ok: false }>): HttpError {
  switch (result.code) {
    case 'not_connected':
      return conflict(`${result.message} Open Settings, then Connections, to connect your calendar.`);
    case 'scope_missing':
      return conflict(`${result.message} Open Settings, then Connections, and allow “Calendar (add and change events)”.`);
    case 'not_found':
      return conflict('That event is no longer in your calendar.');
    default:
      return new HttpError(502, 'internal', 'Your calendar could not be reached. Try again in a minute.');
  }
}

export const calendarOf = (ctx: PluginContext): CalendarConnector | undefined => ctx.providers.get<CalendarConnector>('connector.calendar');

// ---- telling people -----------------------------------------------------------------------------------------------------------------------------------------

/** One small push to everyone who can read the plan's channel: "something changed, ask again". Ids only. */
export async function pushScheduled(ctx: PluginContext, tx: PluginTx, row: { id: string; channel_id: string }, change: ScheduledMeetingChangedPush['change']): Promise<void> {
  const people = (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [row.channel_id])).rows.map((r) => r.person_id);
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, SCHEDULED_MEETING_CHANGED_PUSH, ScheduledMeetingChangedPush.parse({ scheduledMeetingId: row.id, channelId: row.channel_id, change }));
}

export async function emitCancelled(
  ctx: PluginContext,
  tx: PluginTx,
  row: Pick<ScheduledRow, 'id' | 'workspace_id' | 'team_id' | 'channel_id'>,
  by: string | null,
  reason: 'person' | 'calendar_deleted' | 'channel_archived',
): Promise<void> {
  await ctx.audit.emit(
    tx,
    MeetingsScheduledCancelledEvent.parse({
      type: 'meetings.scheduled.cancelled',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      channelId: row.channel_id,
      scheduledMeetingId: row.id,
      cancelledBy: by,
      reason,
      at: ctx.runtime.now().toISOString(),
    }),
  );
}

export async function emitChanged(
  ctx: PluginContext,
  tx: PluginTx,
  row: Pick<ScheduledRow, 'id' | 'workspace_id' | 'team_id' | 'channel_id' | 'starts_at'>,
  by: string | null,
  fields: Array<'title' | 'time' | 'agenda' | 'attendees'>,
): Promise<void> {
  await ctx.audit.emit(
    tx,
    MeetingsScheduledChangedEvent.parse({
      type: 'meetings.scheduled.changed',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      channelId: row.channel_id,
      scheduledMeetingId: row.id,
      changedBy: by,
      fields,
      startsAt: row.starts_at.toISOString(),
      at: ctx.runtime.now().toISOString(),
    }),
  );
}

// ---- planning a room -----------------------------------------------------------------------------------------------------------------------------------------

const MINUTE = 60_000;
/** A little slack so a person who picks "now" in a form that took a minute to fill in is not refused. */
const PAST_GRACE = 2 * MINUTE;

/**
 * Plans a room in a channel: the event at the organizer's own calendar first (its description names the plan), then the plan, the attendees and the events. The invited people of
 * the workspace are those who can read the channel (a typed address that is a workspace person's counts as that person); anyone else is an outside guest: invited by address and counted.
 */
export async function createScheduled(ctx: PluginContext, tx: PluginTx, caller: Caller, channelId: string, body: CreateScheduledMeetingRequest): Promise<ScheduledRow> {
  const can = (await tx.query<{ ok: boolean | null }>("SELECT app.lookup_channel_can($1::uuid, 'post') AS ok", [channelId])).rows[0]?.ok;
  if (can !== true) throw forbidden('You cannot plan a room in this channel');
  const channel = (await tx.query<{ team_id: string | null; archived_at: Date | null; workspace_id: string }>('SELECT team_id, archived_at, workspace_id FROM app.channels WHERE id = $1::uuid', [channelId])).rows[0];
  if (!channel) throw forbidden('You cannot plan a room in this channel');
  if (channel.archived_at !== null) throw conflict('This channel is archived, so no room can be planned in it');

  const now = ctx.runtime.now();
  const startsAt = new Date(body.startsAt);
  if (startsAt.getTime() < now.getTime() - PAST_GRACE) throw invalid('Pick a time that has not passed yet');
  const endsAt = new Date(startsAt.getTime() + body.lengthMinutes * MINUTE);

  const connector = calendarOf(ctx);
  if (!connector) throw conflict('Calendars are not available on this server');
  const who = { workspaceId: channel.workspace_id, personId: caller.personId };
  const connected = await connector.connectedProviders(tx, who);
  const provider = body.calendarProvider ?? connected[0];
  if (!provider || !connected.includes(provider)) throw conflict('Connect your Google or Microsoft calendar to plan a room. Open Settings, then Connections.');

  // who is invited: the picked people and the typed addresses that are workspace people, if they can read the channel; the rest by address
  const readers = new Set((await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [channelId])).rows.map((r) => r.person_id));
  const typed = [...new Set(body.outsideAddresses.map((a) => a.trim().toLowerCase()))];
  const people = (
    await tx.query<{ id: string; email: string }>(
      `SELECT p.id, lower(p.primary_email) AS email FROM app.people p
        WHERE p.status = 'active' AND (p.id = ANY ($1::uuid[]) OR lower(p.primary_email) = ANY ($2::text[]))`,
      [body.attendeePersonIds, typed],
    )
  ).rows;
  const mine = (await tx.query<{ email: string }>('SELECT lower(primary_email) AS email FROM app.people WHERE id = $1::uuid', [caller.personId])).rows[0]?.email ?? '';
  const byId = new Map(people.map((p) => [p.id, p.email]));
  const byEmail = new Map(people.map((p) => [p.email, p.id]));
  const picked = [...new Set(body.attendeePersonIds)].filter((id) => id !== caller.personId);
  const invited = new Set<string>(picked.filter((id) => byId.has(id) && readers.has(id)));
  // a typed address that is a workspace person who can read the channel is that person; any other typed address is an outside guest (invited by address, then forgotten)
  const typedOutside: string[] = [];
  for (const address of typed) {
    if (address === mine) continue;
    const person = byEmail.get(address);
    if (person !== undefined && person !== caller.personId && readers.has(person)) invited.add(person);
    else typedOutside.push(address);
  }
  // picked people who cannot read the channel (or are gone) are not given the link; they are counted with the outside guests
  const dropped = picked.filter((id) => !invited.has(id) && !typedOutside.includes(byId.get(id) ?? '')).length;
  const outsideCount = typedOutside.length + dropped;
  const emails = [...new Set([...[...invited].map((id) => byId.get(id) ?? ''), ...typedOutside].filter((e) => e !== ''))];
  if (invited.size + outsideCount > 50) throw invalid('A planned room can have at most 50 people invited');

  const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
  const link = joinUrl(ctx, id);
  const made = await connector.createEvent(tx, {
    ...who,
    provider,
    ...(body.calendarId ? { calendarId: body.calendarId } : {}),
    event: { title: body.title, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), description: eventDescription(body.agendaMd, link), location: link, attendeeEmails: emails },
  });
  if (!made.ok) throw calendarFailure(made);

  try {
    await tx.query('SELECT app.meetings_schedule($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10::uuid[], $11::int)', [
      id,
      channelId,
      body.title,
      startsAt.toISOString(),
      endsAt.toISOString(),
      body.agendaMd,
      provider,
      body.calendarId ?? null,
      made.value.id,
      [...invited],
      outsideCount,
    ]);
  } catch (err) {
    // the plan could not be written (for example the channel already has a hundred waiting): the event is taken away again, so the calendar does not keep a room that is not there
    await connector.cancelEvent(tx, { ...who, provider, ...(body.calendarId ? { calendarId: body.calendarId } : {}), eventId: made.value.id }).catch(() => undefined);
    throw err;
  }
  const row = (await loadScheduled(tx, id))!;
  await ctx.audit.emit(
    tx,
    MeetingsScheduledCreatedEvent.parse({
      type: 'meetings.scheduled.created',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      channelId: row.channel_id,
      scheduledMeetingId: row.id,
      organizerId: row.organizer_id,
      provider: row.provider,
      startsAt: row.starts_at.toISOString(),
      attendeeCount: row.attendee_ids.length,
      outsideCount: row.outside_count,
      at: now.toISOString(),
    }),
  );
  await pushScheduled(ctx, tx, row, 'created');
  return row;
}

/** Changes a plan its organizer made: the calendar event first (so the two cannot disagree), then the plan. */
export async function updateScheduled(ctx: PluginContext, tx: PluginTx, caller: Caller, id: string, body: UpdateScheduledMeetingRequest): Promise<ScheduledRow> {
  const row = await loadScheduled(tx, id);
  if (!row) throw notFound('That planned room is not available');
  if (row.organizer_id !== caller.actorId) throw forbidden('Only the person who planned this room can change it');
  if (row.status === 'cancelled') throw conflict('This room was cancelled');
  if (row.status === 'started') throw conflict('This room has already been opened');

  const now = ctx.runtime.now();
  const title = body.title !== undefined && body.title.trim() !== row.title ? body.title.trim() : undefined;
  const agenda = body.agendaMd !== undefined && body.agendaMd !== row.agenda_md ? body.agendaMd : undefined;
  const length = body.lengthMinutes ?? Math.round((row.ends_at.getTime() - row.starts_at.getTime()) / MINUTE);
  const startsAt = body.startsAt !== undefined ? new Date(body.startsAt) : row.starts_at;
  const endsAt = new Date(startsAt.getTime() + length * MINUTE);
  const timeChanged = startsAt.getTime() !== row.starts_at.getTime() || endsAt.getTime() !== row.ends_at.getTime();
  if (timeChanged && startsAt.getTime() < now.getTime() - PAST_GRACE) throw invalid('Pick a time that has not passed yet');
  if (timeChanged && startsAt.getTime() > now.getTime() + 366 * 24 * 60 * MINUTE) throw invalid('A room can be planned at most a year ahead');
  const fields: Array<'title' | 'time' | 'agenda'> = [...(title !== undefined ? (['title'] as const) : []), ...(timeChanged ? (['time'] as const) : []), ...(agenda !== undefined ? (['agenda'] as const) : [])];
  if (fields.length === 0) return row;

  const connector = calendarOf(ctx);
  if (!connector) throw conflict('Calendars are not available on this server');
  const personId = caller.personId;
  if (row.external_event_id) {
    const changed = await connector.updateEvent(tx, {
      workspaceId: row.workspace_id,
      personId,
      provider: row.provider,
      ...(row.calendar_id ? { calendarId: row.calendar_id } : {}),
      eventId: row.external_event_id,
      changes: {
        ...(title !== undefined ? { title } : {}),
        ...(timeChanged ? { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } : {}),
        ...(agenda !== undefined ? { description: eventDescription(agenda, joinUrl(ctx, row.id)) } : {}),
      },
    });
    if (!changed.ok) throw calendarFailure(changed);
  }
  // the table has no policy that lets a person write it: the organizer was checked above, the change is written as the system role in its own short transaction
  return ctx.db.system(
    async (stx) => {
      await stx.query(
        `UPDATE app.scheduled_meetings
            SET title = coalesce($2, title), starts_at = $3::timestamptz, ends_at = $4::timestamptz, agenda_md = coalesce($5, agenda_md),
                reminded_at = CASE WHEN $6::boolean THEN NULL ELSE reminded_at END, synced_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status = 'scheduled'`,
        [row.id, title ?? null, startsAt.toISOString(), endsAt.toISOString(), agenda ?? null, timeChanged],
      );
      const next = (await loadScheduled(stx, row.id))!;
      await emitChanged(ctx, stx, next, caller.actorId, fields);
      await pushScheduled(ctx, stx, next, 'changed');
      return next;
    },
    { workspaceId: row.workspace_id },
  );
}

/** Cancels a plan its organizer made, and the event at their calendar. A cancelled plan cancelled again is the same answer. */
export async function cancelScheduled(ctx: PluginContext, tx: PluginTx, caller: Caller, id: string): Promise<ScheduledRow> {
  const row = await loadScheduled(tx, id);
  if (!row) throw notFound('That planned room is not available');
  if (row.organizer_id !== caller.actorId) throw forbidden('Only the person who planned this room can cancel it');
  if (row.status === 'cancelled') return row;
  if (row.status === 'started') throw conflict('This room has already been opened');
  const done = (await tx.query<{ ok: boolean }>('SELECT app.meetings_cancel_scheduled($1::uuid) AS ok', [id])).rows[0]?.ok === true;
  if (!done) throw conflict('This room can no longer be cancelled');
  // The plan is cancelled first, so nobody can open it any more; then the event is taken off the calendar. A calendar that cannot be reached does not keep the plan alive:
  // the event stays there with a link that now says "This meeting was cancelled."
  const connector = calendarOf(ctx);
  if (connector && row.external_event_id) {
    try {
      await connector.cancelEvent(tx, { workspaceId: row.workspace_id, personId: caller.personId, provider: row.provider, ...(row.calendar_id ? { calendarId: row.calendar_id } : {}), eventId: row.external_event_id });
    } catch {
      // the door answers with codes and does not throw; a throw is a bug in a provider, and the cancel above stands
    }
  }
  const next = (await loadScheduled(tx, id))!;
  await emitCancelled(ctx, tx, next, caller.actorId, 'person');
  await pushScheduled(ctx, tx, next, 'cancelled');
  return next;
}

// ---- opening the room ----------------------------------------------------------------------------------------------------------------------------------------

/** The live room of a plan, if one is open. */
export async function liveRoomOf(tx: PluginTx, scheduledMeetingId: string): Promise<string | null> {
  return (await tx.query<{ id: string }>("SELECT id FROM app.meetings WHERE scheduled_meeting_id = $1::uuid AND state = 'live' ORDER BY started_at DESC LIMIT 1", [scheduledMeetingId])).rows[0]?.id ?? null;
}

export async function afterRoomOpened(ctx: PluginContext, tx: PluginTx, row: Pick<ScheduledRow, 'id' | 'workspace_id' | 'channel_id'>): Promise<void> {
  await pushScheduled(ctx, tx, row, 'started');
  // the agenda is read again from the calendar once, by a job: the person who pressed Start does not wait for the calendar
  await ctx.jobs.enqueue(tx, SCHEDULED_AGENDA_QUEUE, { workspaceId: row.workspace_id, scheduledMeetingId: row.id }, { dedupeKey: `agenda:${row.id}` });
}

// ---- a channel is archived -----------------------------------------------------------------------------------------------------------------------------------

export function registerScheduled(ctx: PluginContext): void {
  // An archived channel is read-only: the rooms planned in it are cancelled (in the same transaction), and a job takes their events off the organizers' calendars.
  ctx.events.subscribe('channel.channel.archived', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ChannelChannelArchivedEvent.parse(raw);
    if (!event.archived) return;
    const cancelled = await tx.query<Pick<ScheduledRow, 'id' | 'workspace_id' | 'team_id' | 'channel_id'>>(
      `UPDATE app.scheduled_meetings SET status = 'cancelled', updated_at = now() WHERE channel_id = $1::uuid AND status = 'scheduled' RETURNING id, workspace_id, team_id, channel_id`,
      [event.channelId],
    );
    for (const row of cancelled.rows) {
      await emitCancelled(ctx, tx, row, null, 'channel_archived');
      await pushScheduled(ctx, tx, row, 'cancelled');
      await ctx.jobs.enqueue(tx, SCHEDULED_CANCEL_EVENT_QUEUE, { workspaceId: row.workspace_id, scheduledMeetingId: row.id }, { dedupeKey: `cancel-event:${row.id}` });
    }
  });
}
