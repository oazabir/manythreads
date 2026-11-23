import { enqueue } from '@manythreads/kernel';
import { AppointmentResponse, ListAppointmentsResponse, OpenMeetingSpaceResponse } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';

// P36-04 through the real server: Nadia makes an appointment on Engineering's schedule inviting Sameera (Customer support). Every member of Engineering sees
// it on the team's common schedule; Sameera sees it because she is invited; Tariq (Marketing, not invited) does not. Its meeting space holds the maker and the
// invited. A member who did not make it cannot change it; Nadia moves it, invites Tariq and drops Sameera (the space's members follow), then cancels it.

const { omar, nadia, rafi, sameera, tariq } = personas;
let w: World;
const originalProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
  if (originalProvider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = originalProvider;
});

const day = (h: number): string => new Date(Date.UTC(2030, 0, 15, h, 0, 0)).toISOString();
const list = (who: typeof omar) => w.call<{ appointments: Array<{ id: string; title: string; team: { name: string }; canEdit: boolean; invited: Array<{ personId: string }> }> }>(who, 'GET', `/api/appointments?from=${encodeURIComponent(day(0))}&to=${encodeURIComponent(day(23))}`);
const members = async (channelId: string): Promise<string[]> =>
  (await w.system((tx) => tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_members WHERE channel_id = $1 ORDER BY person_id', [channelId]))).rows.map((r) => r.person_id).sort();

describe('the team schedule (P36-04)', () => {
  let id = '';
  let space = '';

  it('Nadia makes an appointment on Engineering inviting Sameera of another team; it has its own meeting space with the two of them', async () => {
    const res = await w.call<AppointmentResponse>(nadia, 'POST', '/api/teams/engineering/appointments', { title: 'Escalation review', startsAt: day(14), endsAt: day(15), kind: 'video', inviteeIds: [sameera.personId], agenda: 'The open escalations' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const a = AppointmentResponse.parse(res.body).appointment;
    id = a.id;
    space = a.channelId;
    expect(a).toMatchObject({ title: 'Escalation review', kind: 'video', status: 'scheduled', canEdit: true, createdBy: { personId: nadia.personId }, invited: [{ personId: sameera.personId }] });
    expect((await w.system((tx) => tx.query<{ kind: string }>('SELECT kind FROM app.channels WHERE id = $1', [space]))).rows[0]!.kind).toBe('meeting');
    expect(await members(space)).toEqual([nadia.personId, sameera.personId].sort());
  });

  it('every member of Engineering sees it on the common schedule, Sameera sees it as invited, Tariq does not; only who may change it can', async () => {
    const forOmar = ListAppointmentsResponse.parse((await list(omar)).body).appointments;
    expect(forOmar.map((x) => x.id)).toContain(id);
    const forRafi = (await list(rafi)).body.appointments.find((x) => x.id === id)!;
    expect(forRafi).toMatchObject({ canEdit: false });
    const forSameera = (await list(sameera)).body.appointments.find((x) => x.id === id)!;
    expect(forSameera).toMatchObject({ title: 'Escalation review', canEdit: false });
    expect(forSameera.team.name).toBe('Another team');
    expect((await list(tariq)).body.appointments.map((x) => x.id)).not.toContain(id);
    expect((await w.call(rafi, 'PATCH', `/api/appointments/${id}`, { title: 'Mine now' })).status).toBe(403);
    expect((await w.call(sameera, 'POST', `/api/appointments/${id}/cancel`)).status).toBe(403);
  });

  it('Nadia moves it, invites Tariq and drops Sameera: the space follows; then she cancels it', async () => {
    const moved = await w.call<AppointmentResponse>(nadia, 'PATCH', `/api/appointments/${id}`, { startsAt: day(16), endsAt: day(17), inviteeIds: [tariq.personId] });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(AppointmentResponse.parse(moved.body).appointment).toMatchObject({ startsAt: day(16), invited: [{ personId: tariq.personId }] });
    expect(await members(space)).toEqual([nadia.personId, tariq.personId].sort());
    expect((await list(tariq)).body.appointments.map((x) => x.id)).toContain(id);
    expect((await list(sameera)).body.appointments.map((x) => x.id)).not.toContain(id);
    const cancelled = await w.call<AppointmentResponse>(nadia, 'POST', `/api/appointments/${id}/cancel`);
    expect(AppointmentResponse.parse(cancelled.body).appointment.status).toBe('cancelled');
    expect((await w.call(nadia, 'POST', `/api/appointments/${id}/cancel`)).status).toBe(409);
  });

  it('refuses a team the maker is not on, an end before the start, and more than a day', async () => {
    expect((await w.call(nadia, 'POST', '/api/teams/marketing/appointments', { title: 'Not mine', startsAt: day(9), endsAt: day(10) })).status).toBe(403);
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/appointments', { title: 'Backwards', startsAt: day(10), endsAt: day(9) })).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/appointments', { title: 'Too long', startsAt: day(1), endsAt: new Date(Date.UTC(2030, 0, 17)).toISOString() })).status).toBe(400);
  });

  it('the invited are told (P36-06); five minutes before, the reminder goes to the maker and the invited (P36-07); Join opens its call with its kind', async () => {
    const soon = new Date(Date.now() + 3 * 60_000).toISOString();
    const later = new Date(Date.now() + 63 * 60_000).toISOString();
    const made = AppointmentResponse.parse((await w.call<AppointmentResponse>(nadia, 'POST', '/api/teams/engineering/appointments', { title: 'Standup with support', startsAt: soon, endsAt: later, kind: 'video', inviteeIds: [sameera.personId] })).body).appointment;
    const notes = (person: string, kind: string) =>
      w.system((tx) => tx.query<{ preview: string; channel_id: string }>('SELECT preview, channel_id FROM app.notifications WHERE person_id = $1 AND kind = $2 AND ref_id = $3', [person, kind, made.id])).then((r) => r.rows);
    await eventually(async () => ((await notes(sameera.personId, 'appointment_invite')).length === 1 ? true : undefined), 20_000, 'the invitation');
    const invite = (await notes(sameera.personId, 'appointment_invite'))[0]!;
    expect(invite.preview).toContain('invited you to Standup with support');
    expect(invite.channel_id).toBe(made.channelId);
    // the reminder job: it starts in three minutes
    const job = await w.system(async (tx) => (await enqueue(tx, 'meetings.appointment-reminders', {})).id);
    await eventually(async () => ((await w.system((tx) => tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [job]))).rows[0]?.state === 'done' ? true : undefined), 20_000, 'the reminder job');
    await eventually(async () => ((await notes(sameera.personId, 'appointment_soon')).length === 1 && (await notes(nadia.personId, 'appointment_soon')).length === 1 ? true : undefined), 20_000, 'the reminders');
    expect((await notes(sameera.personId, 'appointment_soon'))[0]!.preview).toBe('Standup with support starts in 5 minutes');
    // Join: the call in its space, a video call; Rafi (on the team, not invited) cannot join it
    const joined = await w.call<OpenMeetingSpaceResponse>(sameera, 'POST', `/api/appointments/${made.id}/join`);
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(OpenMeetingSpaceResponse.parse(joined.body)).toMatchObject({ channelId: made.channelId, created: true, meeting: { kind: 'video', channelId: made.channelId } });
    expect(OpenMeetingSpaceResponse.parse((await w.call(nadia, 'POST', `/api/appointments/${made.id}/join`)).body).created).toBe(false);
    expect((await w.call(rafi, 'POST', `/api/appointments/${made.id}/join`)).status).toBe(403);
  });
});
