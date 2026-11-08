import { CreateScheduledMeetingResponse, GetScheduledMeetingResponse, JoinScheduledMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createScheduledWorld, inMinutes, personas, type ScheduledWorld } from './scheduled-world.ts';

// Opening the room of a plan (P16-05, D10): `POST /api/scheduled-meetings/:id/join` starts the room of the plan, or joins the live one; a person who cannot read the channel gets
// the gate sentence data and no room; a cancelled plan and a room that has ended answer plainly. The agenda job reads the event again once the room is open.

const { omar, nadia, rafi, sameera } = personas;
let s: ScheduledWorld;

beforeAll(async () => {
  s = await createScheduledWorld();
  await s.connect(nadia, 'google');
}, 240_000);
afterAll(async () => {
  await s?.close();
});

async function plan(title: string, agendaMd = '') {
  const res = await s.w.call(nadia, 'POST', `/api/channels/${s.general}/scheduled-meetings`, { title, startsAt: inMinutes(60), lengthMinutes: 30, agendaMd });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CreateScheduledMeetingResponse.parse(res.body).scheduledMeeting;
}
const join = (who: typeof omar | null, id: string) => s.w.call(who, 'POST', `/api/scheduled-meetings/${id}/join`);
const row = (id: string) => s.w.system(async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM app.scheduled_meetings WHERE id = $1', [id])).rows[0]!);

describe('joining a plan', () => {
  it('opens the room of the plan for the first reader, joins the same room for the next, and starts the agenda job', async () => {
    const p = await plan('Design review', 'Old agenda');
    // the organizer edits the agenda at the calendar before anybody comes
    const eventId = (await row(p.id))['external_event_id'] as string;
    const at = s.fake.account(nadia.email).events.find((e) => e.id === eventId)!;
    at.description = `Agenda read at the start\n\nJoin: ${at.location ?? ''}`;

    const first = await join(omar, p.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const opened = JoinScheduledMeetingResponse.parse(first.body);
    expect(opened.created).toBe(true);
    expect(opened.meeting).toMatchObject({ channelId: s.general, state: 'live' });
    expect(opened.join.token.length).toBeGreaterThan(10);
    expect((await row(p.id))['status']).toBe('started');
    const linked = await s.w.system(async (tx) => (await tx.query<{ scheduled_meeting_id: string | null }>('SELECT scheduled_meeting_id FROM app.meetings WHERE id = $1', [opened.meeting.id])).rows[0]!.scheduled_meeting_id);
    expect(linked).toBe(p.id);

    const second = JoinScheduledMeetingResponse.parse((await join(rafi, p.id)).body);
    expect(second.created).toBe(false);
    expect(second.meeting.id).toBe(opened.meeting.id);

    // the gate, for a reader of the channel, now says the plan was started
    const got = GetScheduledMeetingResponse.parse((await s.w.call(rafi, 'GET', `/api/scheduled-meetings/${p.id}`)).body);
    expect(got.gate).toMatchObject({ readable: true, status: 'started' });
    expect(got.scheduledMeeting).toMatchObject({ id: p.id, meetingId: opened.meeting.id });

    // the agenda job read the event again: the Scribe will be given what the calendar says now
    await eventually(async () => (await row(p.id))['agenda_md'] === 'Agenda read at the start', 40_000, 'the agenda to be read again');
    // a channel has one live room: this one is closed so the next test opens its own
    expect((await s.w.call(omar, 'POST', `/api/meetings/${opened.meeting.id}/end`)).status).toBe(200);
  });

  it('gives a person who cannot read the channel the gate and no room', async () => {
    const p = await plan('Private matter');
    const rooms = async () => (await s.w.system(async (tx) => (await tx.query('SELECT 1 FROM app.meetings WHERE scheduled_meeting_id = $1', [p.id])).rows.length));
    const res = await join(sameera, p.id);
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('Private matter');
    expect(await rooms()).toBe(0);
    expect((await row(p.id))['status']).toBe('scheduled');
    // nobody signed in: refused
    expect([401, 403]).toContain((await join(null, p.id)).status);
    // the gate names the channel and the organizer, never the title
    const gate = GetScheduledMeetingResponse.parse((await s.w.call(sameera, 'GET', `/api/scheduled-meetings/${p.id}`)).body);
    expect(gate.scheduledMeeting).toBeNull();
    expect(gate.gate.readable).toBe(false);
  });

  it('says a cancelled plan was cancelled, and a plan that does not exist is not found', async () => {
    const p = await plan('Cancelled');
    expect((await s.w.call(nadia, 'DELETE', `/api/scheduled-meetings/${p.id}`)).status).toBe(200);
    const res = await join(omar, p.id);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('This meeting was cancelled.');
    const gate = GetScheduledMeetingResponse.parse((await s.w.call(omar, 'GET', `/api/scheduled-meetings/${p.id}`)).body);
    expect(gate.gate.status).toBe('cancelled');
    expect((await join(omar, '01a1bcc8-eb39-7785-8564-e6e48905cad7')).status).toBe(404);
  });

  it('says a room that has ended has already happened', async () => {
    const p = await plan('Short one');
    const opened = JoinScheduledMeetingResponse.parse((await join(omar, p.id)).body);
    expect(opened.created).toBe(true);
    expect((await s.w.call(omar, 'POST', `/api/meetings/${opened.meeting.id}/end`)).status).toBe(200);
    const again = await join(rafi, p.id);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain('This meeting has already happened.');
  });
});
