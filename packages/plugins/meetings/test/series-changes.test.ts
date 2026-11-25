import { enqueue } from '@manythreads/kernel';
import { AppointmentAgendaResponse, AppointmentResponse, CreateMeetingSeriesResponse, MeetingSeriesResponse, OpenMeetingSpaceResponse } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';

// P17-05 step 2 through the real server: Nadia changes a weekly series to every 2 weeks at another hour from its next meeting; the meetings to come are made
// again (one moved by hand among them too), the people stay, the agenda already written moves to the new first meeting. Notes written after the next agenda are
// added to it once. Sameera, invited from Customer support, reads the agenda through the meeting (not the team's files); Tariq cannot. The reminder of a meeting
// whose agenda is written says so.

const { nadia, rafi, sameera, tariq } = personas;
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

type Row = { id: string; occurrence: number; starts_at: Date; ends_at: Date; status: string; agenda_path: string | null; agenda_notes_meeting_id: string | null };
const occurrences = (seriesId: string): Promise<Row[]> =>
  w
    .system((tx) => tx.query<Row>('SELECT id, occurrence, starts_at, ends_at, status, agenda_path, agenda_notes_meeting_id FROM app.appointments WHERE series_id = $1 ORDER BY occurrence', [seriesId]))
    .then((r) => r.rows);
const read = async (path: string): Promise<string> => {
  const res = await fetch(`${w.server.url}/api/teams/engineering/repo/content?path=${encodeURIComponent(path)}`, {
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: rafi.actorId, workspaceId: rafi.workspaceId }) },
  });
  return res.text();
};
const runJob = async (queue: string, payload: Record<string, unknown>): Promise<void> => {
  const job = await w.system(async (tx) => (await enqueue(tx, queue, payload)).id);
  await eventually(async () => ((await w.system((tx) => tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [job]))).rows[0]?.state === 'done' ? true : undefined), 20_000, queue);
};
const make = async (title: string, start: Date): Promise<CreateMeetingSeriesResponse> => {
  const res = await w.call<CreateMeetingSeriesResponse>(nadia, 'POST', '/api/teams/engineering/meeting-series', {
    title,
    kind: 'video',
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    frequency: 'weekly',
    timeZone: 'UTC',
    inviteeIds: [sameera.personId],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CreateMeetingSeriesResponse.parse(res.body);
};
const day = 86_400_000;

describe('a new rule for a series (step 2)', () => {
  let seriesId = '';
  const start = new Date(Math.ceil((Date.now() + 2 * 3600_000) / 3600_000) * 3600_000);

  it('Nadia changes it to every 2 weeks, an hour later, from the second meeting: the first stays, the rest are made again with the same people', async () => {
    const made = await make('Rule change', start);
    seriesId = made.series.id;
    const before = await occurrences(seriesId);
    expect(before.length).toBe(14);
    // the third meeting was moved by hand; the new rule makes it again
    expect((await w.call(nadia, 'PATCH', `/api/appointments/${before[2]!.id}`, { startsAt: new Date(start.getTime() + 15 * day).toISOString(), endsAt: new Date(start.getTime() + 15 * day + 1800_000).toISOString() })).status).toBe(200);
    expect((await w.call(rafi, 'PATCH', `/api/meeting-series/${seriesId}`, { frequency: 'biweekly' })).status).toBe(403);
    expect((await w.call(nadia, 'PATCH', `/api/meeting-series/${seriesId}`, { startsAt: new Date(start.getTime() + 7 * day).toISOString() })).status).toBe(400);
    const second = before[1]!;
    const newStart = new Date(second.starts_at.getTime() + 3600_000);
    const res = await w.call<MeetingSeriesResponse>(nadia, 'PATCH', `/api/meeting-series/${seriesId}`, {
      frequency: 'biweekly',
      fromAppointmentId: second.id,
      startsAt: newStart.toISOString(),
      endsAt: new Date(newStart.getTime() + 45 * 60_000).toISOString(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = MeetingSeriesResponse.parse(res.body);
    expect(body.series.frequency).toBe('biweekly');
    expect(body.appointment).toMatchObject({ startsAt: newStart.toISOString(), invited: [{ personId: sameera.personId }] });
    const after = await occurrences(seriesId);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after.slice(1).every((o) => !before.some((b) => b.id === o.id))).toBe(true);
    // the numbers go on after the meeting kept
    expect(after[1]!.occurrence).toBe(1);
    const steps = after.slice(1).map((o) => (o.starts_at.getTime() - newStart.getTime()) / day);
    expect(steps.slice(0, 3)).toEqual([0, 14, 28]);
    expect(new Set(after.slice(1).map((o) => o.ends_at.getTime() - o.starts_at.getTime()))).toEqual(new Set([45 * 60_000]));
    const invited = (await w.system((tx) => tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.appointment_invitees i JOIN app.appointments a ON a.id = i.appointment_id WHERE a.series_id = $1 AND i.person_id = $2', [seriesId, sameera.personId]))).rows[0]!.n;
    expect(Number(invited)).toBe(after.length);
    // the planner tops up from the new rule
    await runJob('meetings.series-plan', {});
    const later = await occurrences(seriesId);
    expect(later.slice(1).every((o, i) => o.starts_at.getTime() === newStart.getTime() + i * 14 * day)).toBe(true);
  });

  it('an agenda already written for a meeting made again moves to the new first meeting; a stopped series keeps its rule', async () => {
    const made = await make('Kept agenda', start);
    const id = made.series.id;
    const first = await eventually(async () => (await occurrences(id))[0]?.agenda_path ?? undefined, 20_000, 'the first agenda');
    const res = await w.call<MeetingSeriesResponse>(nadia, 'PATCH', `/api/meeting-series/${id}`, { frequency: 'monthly' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await occurrences(id);
    expect(rows[0]!.agenda_path).toBe(first);
    expect(rows[0]!.starts_at.toISOString()).toBe(start.toISOString());
    expect(rows[1]!.starts_at.getUTCDate()).toBe(new Date(start.getTime()).getUTCDate());
    expect((await w.call(nadia, 'POST', `/api/meeting-series/${id}/stop`)).status).toBe(200);
    expect((await w.call(nadia, 'PATCH', `/api/meeting-series/${id}`, { frequency: 'weekly' })).status).toBe(409);
  });
});

describe('the agenda for everyone invited, notes added later, the reminder (step 2)', () => {
  let seriesId = '';
  let firstId = '';
  const start = new Date(Date.now() + 2 * 3600_000);

  it('Sameera (another team) reads the agenda through the meeting; Rafi gets it editable; Tariq cannot', async () => {
    const made = await make('Shared agenda', start);
    seriesId = made.series.id;
    firstId = made.appointment.id;
    await eventually(async () => (await occurrences(seriesId))[0]?.agenda_path ?? undefined, 20_000, 'the first agenda');
    const one = AppointmentResponse.parse((await w.call(sameera, 'GET', `/api/appointments/${firstId}`)).body).appointment;
    expect(one).toMatchObject({ agendaPath: null, hasAgenda: true });
    const forSameera = await w.call<AppointmentAgendaResponse>(sameera, 'GET', `/api/appointments/${firstId}/agenda`);
    expect(forSameera.status, JSON.stringify(forSameera.body)).toBe(200);
    expect(AppointmentAgendaResponse.parse(forSameera.body)).toMatchObject({ editable: false, truncated: false });
    expect(AppointmentAgendaResponse.parse(forSameera.body).markdown).toContain('# Shared agenda · ');
    expect(AppointmentAgendaResponse.parse((await w.call(rafi, 'GET', `/api/appointments/${firstId}/agenda`)).body).editable).toBe(true);
    expect((await w.call(tariq, 'GET', `/api/appointments/${firstId}/agenda`)).status).toBe(404);
    expect((await w.call(tariq, 'GET', `/api/appointments/${firstId}`)).status).toBe(404);
    const second = (await occurrences(seriesId))[1]!;
    expect((await w.call(sameera, 'GET', `/api/appointments/${second.id}/agenda`)).status).toBe(404);
  });

  it('notes written after the next agenda are added to it once; a box a person took out is not put back', async () => {
    const [first] = await occurrences(seriesId);
    // the first meeting is over and the second's agenda is written before any notes exist
    const joined = OpenMeetingSpaceResponse.parse((await w.call(nadia, 'POST', `/api/appointments/${first!.id}/join`)).body);
    expect((await w.call(nadia, 'POST', `/api/meetings/${joined.meeting.id}/end`)).status).toBe(200);
    await w.system((tx) => tx.query("UPDATE app.appointments SET starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' WHERE id = $1", [first!.id]));
    await w.system((tx) => tx.query("UPDATE app.meetings SET started_at = now() - interval '3 hours' WHERE id = $1", [joined.meeting.id]));
    await runJob('meetings.series-agenda', { seriesId, workspaceId: nadia.workspaceId });
    const second = (await occurrences(seriesId))[1]!;
    expect(second.agenda_path).not.toBeNull();
    expect(await read(second.agenda_path!)).toContain('*Nothing was left open.*');
    // the notes come later; the event's consumer starts the job
    await w.system((tx) =>
      tx.query(`INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location, status, items) VALUES ($1, $2, $3, 'channel_files', 'written', $4::jsonb)`, [
        joined.meeting.id,
        nadia.workspaceId,
        nadia.actorId,
        JSON.stringify([{ kind: 'action', text: 'Send the slides', ownerName: 'Rafi', ownerId: null, due: null, atMs: 0 }]),
      ]),
    );
    await runJob('meetings.series-agenda', { seriesId, workspaceId: nadia.workspaceId });
    const text = await read(second.agenda_path!);
    expect(text).toContain('- [ ] Send the slides — Rafi');
    expect(text).not.toContain('*Nothing was left open.*');
    expect((await occurrences(seriesId))[1]!.agenda_notes_meeting_id).toBe(joined.meeting.id);
    // Nadia takes the item out; another pass does not bring it back
    const res = await w.call(nadia, 'POST', '/api/teams/engineering/repo/commit', { changes: [{ op: 'put', path: second.agenda_path!, content: text.replace('- [ ] Send the slides — Rafi\n', '') }], message: 'Not needed' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await runJob('meetings.series-agenda', { seriesId, workspaceId: nadia.workspaceId });
    expect(await read(second.agenda_path!)).not.toContain('Send the slides');
  });

  it('the reminder of a meeting whose agenda is written says the agenda is ready', async () => {
    const second = (await occurrences(seriesId))[1]!;
    await w.system((tx) => tx.query("UPDATE app.appointments SET starts_at = now() + interval '3 minutes', ends_at = now() + interval '33 minutes', reminded_at = NULL WHERE id = $1", [second.id]));
    await runJob('meetings.appointment-reminders', {});
    const preview = await eventually(
      async () =>
        (await w.system((tx) => tx.query<{ preview: string }>("SELECT preview FROM app.notifications WHERE person_id = $1 AND kind = 'appointment_soon' AND ref_id = $2", [sameera.personId, second.id]))).rows[0]
          ?.preview,
      20_000,
      'the reminder',
    );
    expect(preview).toBe('Shared agenda starts in 5 minutes. The agenda is ready.');
  });
});
