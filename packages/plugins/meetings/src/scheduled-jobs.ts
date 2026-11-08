import type { CalendarEvent, PluginContext, PluginTx } from '@manythreads/sdk';
import { MeetingsScheduledStartingSoonEvent, SCHEDULED_REMINDER_MINUTES, SCHEDULED_AGENDA_MAX, SCHEDULED_MAX_HOURS } from '@manythreads/shared';
import { z } from 'zod';
import {
  SCHEDULED_AGENDA_QUEUE,
  SCHEDULED_CANCEL_EVENT_QUEUE,
  agendaFromDescription,
  calendarOf,
  emitCancelled,
  emitChanged,
  eventDescription,
  joinUrl,
  normalizeText,
  pushScheduled,
  type ScheduledRow,
} from './scheduled.ts';

// Work package C (P16-05, decisions D7, D8, D9): the jobs of planned rooms.
//   meetings.scheduled-reminders  every minute: plans that start within five minutes and were not reminded get `reminded_at` and one `meetings.scheduled.starting_soon` (ids only), in the
//                                 same short transaction, so a plan is reminded once however many servers run the job.
//   meetings.scheduled-sync       every ten minutes: plans starting within 48 hours, the least recently looked at first, at most 50 a pass. Each is read at the organizer's own calendar
//                                 (`getEvent`); a changed time, title or description is copied, a deleted or cancelled event cancels the plan. A grant that is gone leaves the plan as it is.
//   meetings.scheduled-agenda     once when a room opens from a plan: reads the event again so the Scribe is told the agenda as it is then (agenda only; nothing is cancelled).
//   meetings.scheduled-cancel-event  takes the event of a plan the platform cancelled (an archived channel) off the organizer's calendar.
// A job never holds a transaction while it waits for a calendar (MISTAKES P14-08, P15-03): the calendar is asked between short transactions, and a workspace is entered with
// `ctx.db.system(fn, { workspaceId })` (P14-09).
export const SCHEDULED_REMINDERS_QUEUE = 'meetings.scheduled-reminders';
export const SCHEDULED_SYNC_QUEUE = 'meetings.scheduled-sync';
export { SCHEDULED_AGENDA_QUEUE, SCHEDULED_CANCEL_EVENT_QUEUE };

const SYNC_BATCH = 50;
const SYNC_WINDOW_HOURS = 48;
const MAX_MS = SCHEDULED_MAX_HOURS * 60 * 60_000;

const Payload = z.object({ workspaceId: z.uuid(), scheduledMeetingId: z.uuid() });

type DueRow = Pick<ScheduledRow, 'id' | 'workspace_id' | 'team_id' | 'channel_id' | 'starts_at'>;

/** Reminds the plans of one workspace that are due. Returns how many. */
export async function remindDue(ctx: PluginContext, tx: PluginTx): Promise<number> {
  const due = await tx.query<DueRow>(
    `UPDATE app.scheduled_meetings SET reminded_at = now()
      WHERE status = 'scheduled' AND reminded_at IS NULL AND starts_at > now() AND starts_at <= now() + make_interval(mins => $1::int)
      RETURNING id, workspace_id, team_id, channel_id, starts_at`,
    [SCHEDULED_REMINDER_MINUTES],
  );
  for (const row of due.rows) {
    // only the invited people who can still read the channel hear about it
    const people = await tx.query<{ person_id: string }>(
      `SELECT a.person_id FROM app.scheduled_meeting_attendees a
        WHERE a.scheduled_meeting_id = $1::uuid AND a.person_id = ANY (ARRAY(SELECT person_id FROM app.channel_audience($2::uuid))) ORDER BY a.person_id`,
      [row.id, row.channel_id],
    );
    await ctx.audit.emit(
      tx,
      MeetingsScheduledStartingSoonEvent.parse({
        type: 'meetings.scheduled.starting_soon',
        schemaVersion: 1,
        workspaceId: row.workspace_id,
        teamId: row.team_id,
        channelId: row.channel_id,
        scheduledMeetingId: row.id,
        attendeePersonIds: people.rows.map((p) => p.person_id),
        startsAt: row.starts_at.toISOString(),
        at: ctx.runtime.now().toISOString(),
      }),
    );
  }
  return due.rows.length;
}

type SyncRow = Pick<ScheduledRow, 'id' | 'workspace_id' | 'team_id' | 'channel_id' | 'provider' | 'calendar_id' | 'external_event_id' | 'title' | 'starts_at' | 'ends_at' | 'agenda_md' | 'status'> & {
  organizer_person_id: string | null;
};

const SYNC_COLUMNS = `s.id, s.workspace_id, s.team_id, s.channel_id, s.provider, s.calendar_id, s.external_event_id, s.title, s.starts_at, s.ends_at, s.agenda_md, s.status,
  (SELECT a.ref_id FROM app.actors a WHERE a.id = s.organizer_id AND a.kind = 'person') AS organizer_person_id`;

/**
 * Compares one plan with its calendar event and copies what changed. `agendaOnly`: the room is already open, so only the agenda is taken (nothing is cancelled or moved). Reads the
 * calendar first (no transaction), then writes in one short transaction of the plan's workspace. Returns what it did, for the log and the tests.
 */
export async function syncOne(ctx: PluginContext, tx: PluginTx, row: SyncRow, opts: { agendaOnly: boolean }): Promise<'changed' | 'cancelled' | 'same' | 'skipped'> {
  const connector = calendarOf(ctx);
  if (!connector || !row.external_event_id || !row.organizer_person_id) return 'skipped';
  const got = await connector.getEvent(tx, {
    workspaceId: row.workspace_id,
    personId: row.organizer_person_id,
    provider: row.provider,
    ...(row.calendar_id ? { calendarId: row.calendar_id } : {}),
    eventId: row.external_event_id,
  });
  if (!got.ok) {
    // the event is gone at the calendar: the plan goes with it; a grant that is gone or a calendar that is down leaves the plan as it is
    if (got.code === 'not_found' && !opts.agendaOnly) return cancelFor(ctx, row);
    return 'skipped';
  }
  return writeSync(ctx, row, got.value, opts);
}

async function cancelFor(ctx: PluginContext, row: SyncRow): Promise<'cancelled' | 'same'> {
  return ctx.db.system(
    async (tx) => {
      const done = await tx.query("UPDATE app.scheduled_meetings SET status = 'cancelled', synced_at = now(), updated_at = now() WHERE id = $1::uuid AND status = 'scheduled' RETURNING id", [row.id]);
      if (done.rows.length === 0) return 'same';
      await emitCancelled(ctx, tx, row, null, 'calendar_deleted');
      await pushScheduled(ctx, tx, row, 'cancelled');
      return 'cancelled';
    },
    { workspaceId: row.workspace_id },
  );
}

async function writeSync(ctx: PluginContext, row: SyncRow, event: CalendarEvent, opts: { agendaOnly: boolean }): Promise<'changed' | 'cancelled' | 'same'> {
  if (event.cancelled && !opts.agendaOnly) return cancelFor(ctx, row);
  const link = joinUrl(ctx, row.id);
  // what the calendar says now, with our own checks: a title that fits, a time that makes sense, a description that is still our text or someone's edit of it
  const title = [...event.title].map((c) => (/\p{Cc}|\u2028|\u2029/u.test(c) ? ' ' : c)).join('').trim().slice(0, 120);
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const timeOk = Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start && end.getTime() - start.getTime() <= MAX_MS;
  const sent = normalizeText(eventDescription(row.agenda_md, link));
  const agendaNow = normalizeText(event.description) === sent ? row.agenda_md : agendaFromDescription(event.description, link);
  const fields: Array<'title' | 'time' | 'agenda'> = [];
  if (!opts.agendaOnly && title !== '' && title !== row.title) fields.push('title');
  if (!opts.agendaOnly && timeOk && (start.getTime() !== row.starts_at.getTime() || end.getTime() !== row.ends_at.getTime())) fields.push('time');
  if (agendaNow !== row.agenda_md && agendaNow.length <= SCHEDULED_AGENDA_MAX) fields.push('agenda');
  return ctx.db.system(
    async (tx) => {
      if (fields.length === 0) {
        await tx.query('UPDATE app.scheduled_meetings SET synced_at = now() WHERE id = $1::uuid', [row.id]);
        return 'same';
      }
      const changed = await tx.query<{ starts_at: Date }>(
        `UPDATE app.scheduled_meetings
            SET title = CASE WHEN $2::boolean THEN $3 ELSE title END,
                starts_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE starts_at END,
                ends_at = CASE WHEN $4::boolean THEN $6::timestamptz ELSE ends_at END,
                agenda_md = CASE WHEN $7::boolean THEN $8 ELSE agenda_md END,
                reminded_at = CASE WHEN $4::boolean THEN NULL ELSE reminded_at END,
                synced_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status IN ('scheduled', 'started') RETURNING starts_at`,
        [row.id, fields.includes('title'), title, fields.includes('time'), start.toISOString(), end.toISOString(), fields.includes('agenda'), agendaNow],
      );
      const next = changed.rows[0];
      if (!next) return 'same';
      // an agenda copied for the Scribe at room start is not an event worth telling anyone about
      if (!opts.agendaOnly) {
        await emitChanged(ctx, tx, { ...row, starts_at: next.starts_at }, null, fields);
        await pushScheduled(ctx, tx, row, 'changed');
      }
      return 'changed';
    },
    { workspaceId: row.workspace_id },
  );
}

export function registerScheduledJobs(ctx: PluginContext): void {
  ctx.jobs.register(
    SCHEDULED_REMINDERS_QUEUE,
    async (_payload, _unused, job) => {
      // detached: a short transaction to find the workspaces with a plan due, then one per workspace (the audience of a channel needs the workspace in the transaction)
      const workspaces = await job.transaction(async (tx) => {
        const rows = await tx.query<{ workspace_id: string }>(
          `SELECT DISTINCT workspace_id FROM app.scheduled_meetings
            WHERE status = 'scheduled' AND reminded_at IS NULL AND starts_at > now() AND starts_at <= now() + make_interval(mins => $1::int)`,
          [SCHEDULED_REMINDER_MINUTES],
        );
        return rows.rows.map((r) => r.workspace_id);
      });
      let reminded = 0;
      for (const workspaceId of workspaces) reminded += await ctx.db.system((tx) => remindDue(ctx, tx), { workspaceId });
      if (reminded > 0) job.log.info(`meetings: ${reminded} planned room(s) reminded`);
    },
    { cron: '* * * * *', maxAttempts: 1, detached: true },
  );

  ctx.jobs.register(
    SCHEDULED_SYNC_QUEUE,
    async (_payload, tx, job) => {
      const rows = await job.transaction(async (stx) =>
        (
          await stx.query<SyncRow>(
            `SELECT ${SYNC_COLUMNS} FROM app.scheduled_meetings s
              WHERE s.status = 'scheduled' AND s.external_event_id IS NOT NULL AND s.ends_at > now() AND s.starts_at <= now() + make_interval(hours => $1::int)
              ORDER BY s.synced_at NULLS FIRST, s.starts_at LIMIT $2::int`,
            [SYNC_WINDOW_HOURS, SYNC_BATCH],
          )
        ).rows,
      );
      const done = { changed: 0, cancelled: 0, same: 0, skipped: 0 };
      for (const row of rows) {
        try {
          done[await syncOne(ctx, tx, row, { agendaOnly: false })] += 1;
        } catch (err) {
          // one plan's trouble does not stop the others; the next pass tries again
          done.skipped += 1;
          job.log.warn(`meetings: a planned room could not be compared with its calendar (${err instanceof Error ? err.name : 'error'})`);
        }
      }
      if (rows.length > 0) job.log.info(`meetings: ${rows.length} planned room(s) compared with their calendars: ${done.changed} changed, ${done.cancelled} cancelled, ${done.skipped} skipped`);
    },
    { cron: '*/10 * * * *', maxAttempts: 1, detached: true },
  );

  ctx.jobs.register(
    SCHEDULED_AGENDA_QUEUE,
    async (payload, tx, job) => {
      const p = Payload.parse(payload);
      const row = await job.transaction(async (stx) => (await stx.query<SyncRow>(`SELECT ${SYNC_COLUMNS} FROM app.scheduled_meetings s WHERE s.id = $1::uuid`, [p.scheduledMeetingId])).rows[0]);
      if (!row || row.workspace_id !== p.workspaceId) return;
      await syncOne(ctx, tx, row, { agendaOnly: true });
    },
    { maxAttempts: 2, detached: true },
  );

  ctx.jobs.register(
    SCHEDULED_CANCEL_EVENT_QUEUE,
    async (payload, tx, job) => {
      const p = Payload.parse(payload);
      const row = await job.transaction(async (stx) => (await stx.query<SyncRow>(`SELECT ${SYNC_COLUMNS} FROM app.scheduled_meetings s WHERE s.id = $1::uuid`, [p.scheduledMeetingId])).rows[0]);
      const connector = calendarOf(ctx);
      if (!row || row.workspace_id !== p.workspaceId || row.status !== 'cancelled' || !row.external_event_id || !row.organizer_person_id || !connector) return;
      const done = await connector.cancelEvent(tx, {
        workspaceId: row.workspace_id,
        personId: row.organizer_person_id,
        provider: row.provider,
        ...(row.calendar_id ? { calendarId: row.calendar_id } : {}),
        eventId: row.external_event_id,
      });
      // a calendar that is down is tried again; a grant that is gone cannot be helped (the link in the event says "This meeting was cancelled.")
      if (!done.ok && done.code === 'provider_down') throw new Error('the calendar could not be reached');
      if (!done.ok) job.log.warn(`meetings: the calendar event of a cancelled planned room could not be removed (${done.code})`);
    },
    { maxAttempts: 4, detached: true },
  );
}
