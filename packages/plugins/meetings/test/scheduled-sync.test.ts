import { enqueue } from '@manythreads/kernel';
import { CreateScheduledMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createScheduledWorld, inMinutes, personas, type ScheduledWorld } from './scheduled-world.ts';

// Keeping a plan and its calendar event together (P16-05, D8): the sync job reads the organizer's event again; a changed time, title or agenda is copied, a deleted or cancelled
// event cancels the plan, and an event that is still the same changes nothing.

const { nadia, omar } = personas;
let s: ScheduledWorld;

beforeAll(async () => {
  s = await createScheduledWorld();
  await s.connect(nadia, 'google');
}, 240_000);
afterAll(async () => {
  await s?.close();
});

async function plan(title: string, agendaMd = '') {
  const res = await s.w.call(nadia, 'POST', `/api/channels/${s.general}/scheduled-meetings`, { title, startsAt: inMinutes(300), lengthMinutes: 30, agendaMd, attendeePersonIds: [omar.personId] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const made = CreateScheduledMeetingResponse.parse(res.body).scheduledMeeting;
  const eventId = (await row(made.id))['external_event_id'] as string;
  return { ...made, eventId, event: s.fake.account(nadia.email).events.find((e) => e.id === eventId)! };
}
const row = (id: string) => s.w.system(async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM app.scheduled_meetings WHERE id = $1', [id])).rows[0]!);
const sync = () => s.w.system((tx) => enqueue(tx, 'meetings.scheduled-sync', {}));
const synced = (id: string, since: number) => async () => {
  const r = await row(id);
  return r['synced_at'] instanceof Date && r['synced_at'].getTime() >= since ? r : undefined;
};
const changedEvents = (id: string) =>
  s.w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'meetings.scheduled.changed' AND payload->>'scheduledMeetingId' = $1", [id])).rows.map((r) => r.payload));

describe('the sync job', () => {
  it('copies a time, a title and an agenda the organizer changed at the calendar, and says so once', async () => {
    const p = await plan('Design review', 'First agenda');
    const before = Date.now();
    const start = new Date(Date.parse(p.startsAt) + 3_600_000);
    p.event.title = 'Design review (moved)';
    p.event.start = start.toISOString();
    p.event.end = new Date(start.getTime() + 60 * 60_000).toISOString();
    p.event.description = 'Second agenda\n\nJoin: ' + (p.event.location ?? '');
    await sync();
    const after = await eventually(synced(p.id, before), 40_000, 'the sync');
    expect(after).toMatchObject({ title: 'Design review (moved)', agenda_md: 'Second agenda', status: 'scheduled' });
    expect((after['starts_at'] as Date).toISOString()).toBe(start.toISOString());
    expect((after['ends_at'] as Date).getTime() - (after['starts_at'] as Date).getTime()).toBe(60 * 60_000);
    expect(after['reminded_at']).toBeNull();
    const events = await changedEvents(p.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ changedBy: null });
    expect(JSON.stringify(events[0])).not.toMatch(/moved|Second agenda/);
    // the people who read the channel see the new time at once
    const list = await s.w.call(omar, 'GET', `/api/channels/${s.general}/scheduled-meetings`);
    expect(JSON.stringify(list.body)).toContain(start.toISOString());

    // the next pass finds nothing to copy
    const again = Date.now();
    await sync();
    await eventually(synced(p.id, again), 40_000, 'the second sync');
    expect(await changedEvents(p.id)).toHaveLength(1);
  });

  it('refuses an end before the start and keeps the old time', async () => {
    const p = await plan('Bad times');
    const before = Date.now();
    p.event.end = new Date(Date.parse(p.event.start) - 60_000).toISOString();
    await sync();
    const after = await eventually(synced(p.id, before), 40_000, 'the sync');
    expect((after['starts_at'] as Date).toISOString()).toBe(p.startsAt);
    expect((after['ends_at'] as Date).toISOString()).toBe(p.endsAt);
  });

  it('cancels the plan when the event is deleted at the calendar', async () => {
    const p = await plan('Deleted there');
    s.fake.account(nadia.email).events = s.fake.account(nadia.email).events.filter((e) => e.id !== p.eventId);
    await sync();
    await eventually(async () => (await row(p.id))['status'] === 'cancelled', 40_000, 'the plan to be cancelled');
    const gone = await s.w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'meetings.scheduled.cancelled' AND payload->>'scheduledMeetingId' = $1", [p.id])).rows);
    expect(gone).toHaveLength(1);
    expect(gone[0]!.payload).toMatchObject({ reason: 'calendar_deleted', cancelledBy: null });
  });

  it('cancels the plan when the event is cancelled at the calendar', async () => {
    const p = await plan('Cancelled there');
    p.event.status = 'cancelled';
    await sync();
    await eventually(async () => (await row(p.id))['status'] === 'cancelled', 40_000, 'the plan to be cancelled');
  });
});
