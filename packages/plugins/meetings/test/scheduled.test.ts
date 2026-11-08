import { CreateChannelResponse, CreateScheduledMeetingResponse, GetScheduledMeetingResponse, ListScheduledMeetingsResponse, UpdateScheduledMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createScheduledWorld, inMinutes, personas, type ScheduledWorld } from './scheduled-world.ts';

// Rooms planned ahead (P16-05): the organizer's click is the consent; one event at the organizer's own calendar with the join link in its description and its location; people of
// the workspace become attendees, outside addresses are invited and then forgotten (only their number is kept); the organizer changes and cancels; a channel archived cancels the
// plans in it. Fake Google and Microsoft 365 stand in for the providers.

const { omar, nadia, rafi, sameera, tariq } = personas;
let s: ScheduledWorld;
let planId: string;

beforeAll(async () => {
  s = await createScheduledWorld();
  await s.connect(nadia, 'google');
  await s.connect(rafi, 'microsoft');
  // Tariq has connected Google for free and busy only: he can ask when people are free, but not make an event
  await s.connect(tariq, 'google', ['calendar_free_busy']);
}, 240_000);
afterAll(async () => {
  await s?.close();
});

const create = (who: typeof nadia | null, channelId: string, body: Record<string, unknown>) => s.w.call(who, 'POST', `/api/channels/${channelId}/scheduled-meetings`, body);
const events = (type: string) => s.w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));
const rowOf = (id: string) => s.w.system(async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM app.scheduled_meetings WHERE id = $1', [id])).rows[0]);

describe('planning a room', () => {
  it('makes one event at the organizer’s calendar with the join link in its description and its location, and maps the people', async () => {
    const before = s.fake.createdEvents.length;
    const res = await create(nadia, s.general, {
      title: 'Design review',
      startsAt: inMinutes(180),
      lengthMinutes: 45,
      agendaMd: '1. The new header\n2. Colours',
      // Rafi and Omar are in the channel; Sameera is on another team (she cannot read it), so she is counted with the outside guests and not invited
      attendeePersonIds: [rafi.personId, omar.personId, sameera.personId],
      outsideAddresses: ['X@Outside.test', rafi.email],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const plan = CreateScheduledMeetingResponse.parse(res.body).scheduledMeeting;
    planId = plan.id;
    expect(plan).toMatchObject({ title: 'Design review', status: 'scheduled', provider: 'google', attendeeCount: 2, outsideCount: 2, meetingId: null, joinPath: `/join/${plan.id}` });
    expect(plan.attendeePersonIds.sort()).toEqual([omar.personId, rafi.personId].sort());
    expect(new Date(plan.endsAt).getTime() - new Date(plan.startsAt).getTime()).toBe(45 * 60_000);

    // exactly one event, at Nadia's own calendar
    expect(s.fake.createdEvents).toHaveLength(before + 1);
    const event = s.fake.createdEvents.at(-1)!;
    expect(event).toMatchObject({ provider: 'google', account: nadia.email, title: 'Design review' });
    // the two people of the workspace and the outside address are invited by address; Sameera is not, and nobody is invited twice
    expect([...event.guests].sort()).toEqual([omar.email, rafi.email, 'x@outside.test'].sort());
    // the link is in both the description (after the agenda) and the location
    const detail = s.fake.createdEventDetails.at(-1)!;
    expect(detail.location).toMatch(new RegExp(`/join/${plan.id}$`));
    expect(detail.description).toContain('1. The new header');
    expect(detail.description).toContain(detail.location);

    // the plan row keeps the event's id and a count; no outside address is stored anywhere
    const row = await rowOf(plan.id);
    expect(row?.['external_event_id']).toBe(detail.eventId);
    expect(row?.['outside_count']).toBe(2);
    const stored = await s.w.system(async (tx) => {
      const rows = await tx.query<{ t: string }>(
        `SELECT (SELECT coalesce(string_agg(row_to_json(m)::text, ' '), '') FROM app.scheduled_meetings m) || ' ' ||
                (SELECT coalesce(string_agg(row_to_json(a)::text, ' '), '') FROM app.scheduled_meeting_attendees a) || ' ' ||
                (SELECT coalesce(string_agg(payload::text, ' '), '') FROM app.events WHERE type LIKE 'meetings.scheduled.%') AS t`,
      );
      return rows.rows[0]!.t;
    });
    expect(stored).not.toContain('outside.test');
  });

  it('says so in an event with ids and counts, not words', async () => {
    const [created] = (await events('meetings.scheduled.created')).filter((e) => e['scheduledMeetingId'] === planId);
    expect(created).toMatchObject({ scheduledMeetingId: planId, channelId: s.general, attendeeCount: 2, outsideCount: 2, provider: 'google' });
    expect(JSON.stringify(created)).not.toMatch(/Design review|outside\.test|@kahf/);
  });

  it('is read by the people who can read the channel, and by nobody else', async () => {
    const asOmar = await s.w.call(omar, 'GET', `/api/channels/${s.general}/scheduled-meetings`);
    expect(asOmar.status).toBe(200);
    expect(ListScheduledMeetingsResponse.parse(asOmar.body).scheduledMeetings.map((p) => p.id)).toContain(planId);
    expect(ListScheduledMeetingsResponse.parse((await s.w.call(omar, 'GET', `/api/channels/${s.general}/scheduled-meetings?upcoming=1&limit=1`)).body).scheduledMeetings.map((p) => p.id)).toContain(planId);
    // Sameera is not in Engineering: the channel is not hers
    const asSameera = await s.w.call(sameera, 'GET', `/api/channels/${s.general}/scheduled-meetings`);
    expect(asSameera.status === 200 ? ListScheduledMeetingsResponse.parse(asSameera.body).scheduledMeetings : []).toEqual([]);
    // her link says only what the plan is, never what it is about
    const gate = await s.w.call(sameera, 'GET', `/api/scheduled-meetings/${planId}`);
    expect(gate.status).toBe(200);
    const parsed = GetScheduledMeetingResponse.parse(gate.body);
    expect(parsed.scheduledMeeting).toBeNull();
    expect(parsed.gate).toMatchObject({ readable: false, status: 'scheduled' });
    expect(JSON.stringify(gate.body)).not.toContain('Design review');
  });

  it('refuses what cannot work, and leaves no event behind', async () => {
    const calls = s.fake.createdEvents.length;
    const good = { title: 'Standup', startsAt: inMinutes(60), lengthMinutes: 30 };
    // no calendar connected (Omar), only free and busy agreed (Tariq: not a member of Engineering's channel either, so use Rafi's channel rights with Tariq's scope below)
    const none = await create(omar, s.general, good);
    expect(none.status).toBe(409);
    expect(JSON.stringify(none.body)).toMatch(/Connect your Google or Microsoft calendar/);
    // somebody who cannot post in the channel
    expect((await create(sameera, s.general, good)).status).toBe(403);
    // a time that has passed
    expect((await create(nadia, s.general, { ...good, startsAt: new Date(Date.now() - 3 * 3_600_000).toISOString() })).status).toBe(400);
    // more than fifty people
    const many = await create(nadia, s.general, { ...good, outsideAddresses: Array.from({ length: 51 }, (_, i) => `p${i}@outside.test`) });
    expect(many.status).toBe(400);
    // a title that is only spaces
    expect((await create(nadia, s.general, { ...good, title: '   ' })).status).toBe(400);
    expect(s.fake.createdEvents).toHaveLength(calls);
  });

  it('answers a calendar that cannot be reached with a plain sentence, and plans nothing', async () => {
    const plans = (await s.w.system(async (tx) => (await tx.query('SELECT 1 FROM app.scheduled_meetings')).rows.length));
    s.fake.failNextApi(500, 1);
    const res = await create(nadia, s.general, { title: 'Offsite call', startsAt: inMinutes(90), lengthMinutes: 30 });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).toMatch(/calendar could not be reached/);
    expect(await s.w.system(async (tx) => (await tx.query('SELECT 1 FROM app.scheduled_meetings')).rows.length)).toBe(plans);
  });

  it('uses Microsoft 365 for a person who has connected only that', async () => {
    const res = await create(rafi, s.general, { title: 'Pairing', startsAt: inMinutes(120), lengthMinutes: 30, outsideAddresses: ['guest@outside.test'] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(CreateScheduledMeetingResponse.parse(res.body).scheduledMeeting.provider).toBe('microsoft');
    expect(s.fake.createdEvents.at(-1)).toMatchObject({ provider: 'microsoft', account: rafi.email, title: 'Pairing' });
  });
});

describe('changing and cancelling', () => {
  it('lets only the organizer change it, and changes the event first', async () => {
    const other = await s.w.call(omar, 'PATCH', `/api/scheduled-meetings/${planId}`, { title: 'Mine now' });
    expect(other.status).toBe(403);
    const when = inMinutes(240);
    const res = await s.w.call(nadia, 'PATCH', `/api/scheduled-meetings/${planId}`, { title: 'Design review (moved)', startsAt: when, agendaMd: 'Only the header' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const plan = UpdateScheduledMeetingResponse.parse(res.body).scheduledMeeting;
    expect(plan).toMatchObject({ title: 'Design review (moved)', startsAt: when, agendaMd: 'Only the header' });
    const update = s.fake.updatedEvents.at(-1)!;
    expect(update.account).toBe(nadia.email);
    expect(update.fields).toMatchObject({ summary: 'Design review (moved)' });
    expect(String(update.fields['description'])).toContain('Only the header');
    const [changed] = (await events('meetings.scheduled.changed')).filter((e) => e['scheduledMeetingId'] === planId);
    expect(changed).toMatchObject({ scheduledMeetingId: planId });
    expect(JSON.stringify(changed)).not.toMatch(/moved|Only the header/);
    // a time that has passed is refused
    expect((await s.w.call(nadia, 'PATCH', `/api/scheduled-meetings/${planId}`, { startsAt: new Date(Date.now() - 3_600_000).toISOString() })).status).toBe(400);
  });

  it('cancels from the organizer only, takes the event off the calendar, and says the same thing twice', async () => {
    const made = CreateScheduledMeetingResponse.parse((await create(nadia, s.general, { title: 'Cancel me', startsAt: inMinutes(300), lengthMinutes: 30 })).body).scheduledMeeting;
    const eventId = (await rowOf(made.id))?.['external_event_id'] as string;
    expect((await s.w.call(omar, 'DELETE', `/api/scheduled-meetings/${made.id}`)).status).toBe(403);
    const done = await s.w.call(nadia, 'DELETE', `/api/scheduled-meetings/${made.id}`);
    expect(done.status).toBe(200);
    expect(s.fake.deletedEvents).toContainEqual({ provider: 'google', account: nadia.email, eventId });
    expect(s.fake.account(nadia.email).events.some((e) => e.id === eventId)).toBe(false);
    const [gone] = (await events('meetings.scheduled.cancelled')).filter((e) => e['scheduledMeetingId'] === made.id);
    expect(gone).toMatchObject({ reason: 'person', scheduledMeetingId: made.id });
    // again: the same answer, no second call to the calendar
    const calls = s.fake.deletedEvents.length;
    expect((await s.w.call(nadia, 'DELETE', `/api/scheduled-meetings/${made.id}`)).status).toBe(200);
    expect(s.fake.deletedEvents).toHaveLength(calls);
    // a cancelled plan cannot be changed
    expect((await s.w.call(nadia, 'PATCH', `/api/scheduled-meetings/${made.id}`, { title: 'again' })).status).toBe(409);
  });

  it('keeps the plan cancelled even when the calendar cannot be reached', async () => {
    const made = CreateScheduledMeetingResponse.parse((await create(nadia, s.general, { title: 'Cancel while down', startsAt: inMinutes(320), lengthMinutes: 30 })).body).scheduledMeeting;
    s.fake.failNextApi(500, 1);
    expect((await s.w.call(nadia, 'DELETE', `/api/scheduled-meetings/${made.id}`)).status).toBe(200);
    expect((await rowOf(made.id))?.['status']).toBe('cancelled');
  });
});

describe('an archived channel', () => {
  it('cancels the plans in it and takes their events off the organizers’ calendars', async () => {
    const channel = CreateChannelResponse.parse((await s.w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'sched-archive' })).body).channel;
    expect((await s.w.call(nadia, 'POST', `/api/channels/${channel.id}/join`)).status).toBeLessThan(300);
    const doomed = await create(nadia, channel.id, { title: 'Doomed', startsAt: inMinutes(400), lengthMinutes: 30 });
    expect(doomed.status, JSON.stringify(doomed.body)).toBe(201);
    const made = CreateScheduledMeetingResponse.parse(doomed.body).scheduledMeeting;
    const eventId = (await rowOf(made.id))?.['external_event_id'] as string;
    const archived = await s.w.call(omar, 'POST', `/api/channels/${channel.id}/archive`);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    // consumers of the archive event run after the request; wait for the plan to follow
    await eventually(async () => (await rowOf(made.id))?.['status'] === 'cancelled', 30_000, 'the plan to be cancelled');
    const [gone] = (await events('meetings.scheduled.cancelled')).filter((e) => e['scheduledMeetingId'] === made.id);
    expect(gone).toMatchObject({ reason: 'channel_archived', cancelledBy: null });
    // the job that removes the event runs on its own
    await eventually(async () => s.fake.deletedEvents.some((d) => d.eventId === eventId && d.account === nadia.email), 30_000, 'the event to be removed from the organizer’s calendar');
  });
});
