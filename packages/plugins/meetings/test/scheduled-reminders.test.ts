import { enqueue } from '@manythreads/kernel';
import { CreateScheduledMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createScheduledWorld, inMinutes, personas, type ScheduledWorld } from './scheduled-world.ts';

// "Starts in 5 minutes" (P16-05, D7): the reminder job gives a plan that is about to start `reminded_at` and says `meetings.scheduled.starting_soon` once, with the invited people who
// can read the channel; the notifications plugin turns that into one `meeting_soon` row for each of them.

const { omar, nadia, rafi, sameera } = personas;
let s: ScheduledWorld;

beforeAll(async () => {
  s = await createScheduledWorld();
  await s.connect(nadia, 'google');
}, 240_000);
afterAll(async () => {
  await s?.close();
});

const plan = async (title: string, minutes: number, attendees: string[]) => {
  const res = await s.w.call(nadia, 'POST', `/api/channels/${s.general}/scheduled-meetings`, { title, startsAt: inMinutes(120), lengthMinutes: 30, attendeePersonIds: attendees });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const made = CreateScheduledMeetingResponse.parse(res.body).scheduledMeeting;
  // move it in time by the database's own clock, as time passing would
  await s.w.system((tx) => tx.query("UPDATE app.scheduled_meetings SET starts_at = now() + make_interval(mins => $2::int), ends_at = now() + make_interval(mins => $2::int + 30) WHERE id = $1", [made.id, minutes]));
  return made;
};
const reminded = (id: string) => s.w.system(async (tx) => (await tx.query<{ reminded_at: Date | null }>('SELECT reminded_at FROM app.scheduled_meetings WHERE id = $1', [id])).rows[0]!.reminded_at);
const runJob = () => s.w.system((tx) => enqueue(tx, 'meetings.scheduled-reminders', {}));
const soon = (id: string) =>
  s.w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'meetings.scheduled.starting_soon' AND payload->>'scheduledMeetingId' = $1", [id])).rows.map((r) => r.payload));
const notificationsOf = (id: string) =>
  s.w.system(async (tx) => (await tx.query<{ person_id: string; kind: string; ref_type: string; preview: string; channel_id: string }>("SELECT person_id, kind, ref_type, preview, channel_id FROM app.notifications WHERE ref_id = $1 ORDER BY person_id", [id])).rows);

const stateOf = (id: string) =>
  s.w.system(async (tx) => (await tx.query<{ id: string; preview: string; read_at: Date | null; created_at: Date }>('SELECT id, preview, read_at, created_at FROM app.notifications WHERE ref_id = $1', [id])).rows);

describe('the reminder job', () => {
  it('reminds the invited people once, five minutes before, and nobody else', async () => {
    const due = await plan('Design review', 3, [rafi.personId, omar.personId, sameera.personId]);
    const later = await plan('Next week', 90, [rafi.personId]);
    const cancelled = await plan('Cancelled one', 2, [rafi.personId]);
    expect((await s.w.call(nadia, 'DELETE', `/api/scheduled-meetings/${cancelled.id}`)).status).toBe(200);

    await runJob();
    await eventually(async () => (await reminded(due.id)) !== null, 30_000, 'the plan to be reminded');
    await eventually(async () => (await notificationsOf(due.id)).length >= 2, 30_000, 'the notifications');

    // one event, ids only: the two readers (Sameera could not read the channel, so she was never invited)
    const events = await soon(due.id);
    expect(events).toHaveLength(1);
    expect((events[0]!['attendeePersonIds'] as string[]).sort()).toEqual([omar.personId, rafi.personId].sort());
    expect(JSON.stringify(events[0])).not.toMatch(/Design review|@kahf/);

    const rows = await notificationsOf(due.id);
    expect(rows.map((r) => r.person_id).sort()).toEqual([omar.personId, rafi.personId].sort());
    for (const r of rows) expect(r).toMatchObject({ kind: 'meeting_soon', ref_type: 'scheduled_meeting', channel_id: s.general, preview: 'Design review starts in 5 minutes' });

    // a plan more than five minutes away, and a cancelled one, are left alone
    expect(await reminded(later.id)).toBeNull();
    expect(await reminded(cancelled.id)).toBeNull();
    expect(await soon(later.id)).toEqual([]);
    expect(await notificationsOf(cancelled.id)).toEqual([]);

    // the person reads it as a notification of the right kind, and it opens the join page
    const inbox = await s.w.call(rafi, 'GET', '/api/notifications');
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(inbox.body)).toContain('meeting_soon');

    // the job runs again a minute later: nothing is said twice
    await runJob();
    await new Promise((r) => setTimeout(r, 2500));
    expect(await soon(due.id)).toHaveLength(1);
    expect(await notificationsOf(due.id)).toHaveLength(2);
  });

  it('reminds again after the organizer moves the time into the window, and the person sees it again', async () => {
    const p = await plan('Moved', 3, [rafi.personId]);
    await runJob();
    await eventually(async () => (await reminded(p.id)) !== null, 30_000, 'the first reminder');
    await eventually(async () => (await notificationsOf(p.id)).length === 1, 30_000, 'the first notification');
    // Rafi reads it
    const first = await s.w.system(async (tx) => (await tx.query<{ id: string; created_at: Date }>('SELECT id, created_at FROM app.notifications WHERE ref_id = $1', [p.id])).rows[0]!);
    expect((await s.w.call(rafi, 'POST', '/api/notifications/mark-read', { ids: [first.id] })).status).toBe(200);
    expect((await stateOf(p.id))[0]!.read_at).not.toBeNull();

    // a new time (and a new title): the reminder is due again for the new time
    const moved = await s.w.call(nadia, 'PATCH', `/api/scheduled-meetings/${p.id}`, { title: 'Moved again', startsAt: inMinutes(200) });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await reminded(p.id)).toBeNull();
    // the new time comes up (by the database's clock)
    await s.w.system((tx) => tx.query("UPDATE app.scheduled_meetings SET starts_at = now() + interval '3 minutes', ends_at = now() + interval '33 minutes' WHERE id = $1", [p.id]));
    await runJob();
    await eventually(async () => (await soon(p.id)).length === 2, 30_000, 'the second event');

    // the same row is raised: one row, unread again, newer, with the title as it is now; the person sees it in the inbox
    const rows = await eventually(async () => {
      const r = await stateOf(p.id);
      return r.length === 1 && r[0]!.read_at === null ? r : undefined;
    }, 30_000, 'the notification raised again');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.preview).toBe('Moved again starts in 5 minutes');
    expect(rows[0]!.created_at.getTime()).toBeGreaterThan(first.created_at.getTime());
    const inbox = await s.w.call(rafi, 'GET', '/api/notifications?unread=true');
    expect(JSON.stringify(inbox.body)).toContain('Moved again starts in 5 minutes');

    // the job runs again: nothing more is said
    await runJob();
    await new Promise((r) => setTimeout(r, 2500));
    expect(await soon(p.id)).toHaveLength(2);
    expect(await stateOf(p.id)).toHaveLength(1);
  });
});
