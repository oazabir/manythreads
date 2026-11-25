import { enqueue } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { CreateMeetingSeriesResponse, ListAppointmentsResponse, MeetingSeriesResponse, OpenMeetingSpaceResponse } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { planOccurrences } from '../src/series.ts';

// P17-05 through the real server: Nadia makes a weekly series on Engineering's schedule inviting Sameera (Customer support). Its meetings share one space; the team
// and the invited see them, Tariq does not. The platform writes the folder's README and the first agenda; Nadia edits it (a person changes an agenda that exists,
// nothing else under meetings/); after the first meeting, its call's written notes and the boxes left unticked are carried into the next agenda, a Personal copy's
// items and the ticked ones are not. The rule keeps the local time across a change of clocks, a month from the 31st and an end day.

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

type Row = { id: string; occurrence: number; starts_at: Date; ends_at: Date; status: string; agenda_path: string | null };
const occurrences = (seriesId: string): Promise<Row[]> =>
  w.system((tx) => tx.query<Row>('SELECT id, occurrence, starts_at, ends_at, status, agenda_path FROM app.appointments WHERE series_id = $1 ORDER BY occurrence', [seriesId])).then((r) => r.rows);
const members = async (channelId: string): Promise<string[]> =>
  (await w.system((tx) => tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_members WHERE channel_id = $1', [channelId]))).rows.map((r) => r.person_id).sort();
const read = async (who: typeof omar, path: string): Promise<{ status: number; text: string }> => {
  const res = await fetch(`${w.server.url}/api/teams/engineering/repo/content?path=${encodeURIComponent(path)}`, {
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) },
  });
  return { status: res.status, text: await res.text() };
};
const commit = (who: typeof omar, changes: unknown[]) => w.call(who, 'POST', '/api/teams/engineering/repo/commit', { changes, message: 'Edit the agenda' });
const plan = (seriesId: string, until: string) => w.system((tx) => planOccurrences(tx as unknown as PluginTx, seriesId, new Date(until)));
const make = async (body: Record<string, unknown>) => {
  const res = await w.call<CreateMeetingSeriesResponse>(nadia, 'POST', '/api/teams/engineering/meeting-series', { kind: 'video', inviteeIds: [], ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CreateMeetingSeriesResponse.parse(res.body);
};

describe('the rule of a series', () => {
  it('a weekly meeting at 10:00 in Berlin stays at 10:00 after the clocks change', async () => {
    const { series } = await make({ title: 'Berlin weekly', startsAt: '2030-03-19T09:00:00.000Z', endsAt: '2030-03-19T09:30:00.000Z', frequency: 'weekly', timeZone: 'Europe/Berlin' });
    await plan(series.id, '2030-04-10T00:00:00Z');
    const starts = (await occurrences(series.id)).map((o) => o.starts_at.toISOString());
    expect(starts).toEqual(['2030-03-19T09:00:00.000Z', '2030-03-26T09:00:00.000Z', '2030-04-02T08:00:00.000Z', '2030-04-09T08:00:00.000Z']);
    const ends = (await occurrences(series.id)).map((o) => o.ends_at.getTime() - o.starts_at.getTime());
    expect(new Set(ends)).toEqual(new Set([30 * 60_000]));
  });

  it('a monthly one from the 31st falls on the last day of a shorter month; every two weeks stops on its end day; the time zone must be known', async () => {
    const monthly = await make({ title: 'Month end', startsAt: '2030-01-31T10:00:00.000Z', endsAt: '2030-01-31T11:00:00.000Z', frequency: 'monthly', timeZone: 'UTC' });
    await plan(monthly.series.id, '2030-05-01T00:00:00Z');
    expect((await occurrences(monthly.series.id)).map((o) => o.starts_at.toISOString().slice(0, 10))).toEqual(['2030-01-31', '2030-02-28', '2030-03-31', '2030-04-30']);
    const fortnight = await make({ title: 'Fortnight', startsAt: '2030-06-03T10:00:00.000Z', endsAt: '2030-06-03T11:00:00.000Z', frequency: 'biweekly', untilDate: '2030-07-01', timeZone: 'UTC' });
    await plan(fortnight.series.id, '2030-12-01T00:00:00Z');
    expect((await occurrences(fortnight.series.id)).map((o) => o.starts_at.toISOString().slice(0, 10))).toEqual(['2030-06-03', '2030-06-17', '2030-07-01']);
    const bad = await w.call(nadia, 'POST', '/api/teams/engineering/meeting-series', { title: 'Nowhere', startsAt: '2030-06-03T10:00:00.000Z', endsAt: '2030-06-03T11:00:00.000Z', frequency: 'weekly', timeZone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    const backwards = await w.call(nadia, 'POST', '/api/teams/engineering/meeting-series', { title: 'Backwards', startsAt: '2030-06-03T10:00:00.000Z', endsAt: '2030-06-03T11:00:00.000Z', frequency: 'weekly', untilDate: '2030-06-01', timeZone: 'UTC' });
    expect(backwards.status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/teams/marketing/meeting-series', { title: 'Not mine', startsAt: '2030-06-03T10:00:00.000Z', endsAt: '2030-06-03T11:00:00.000Z', frequency: 'weekly', timeZone: 'UTC' })).status).toBe(403);
  });
});

describe('a weekly series with its agenda (P17-05)', () => {
  let seriesId = '';
  let space = '';
  let slug = '';
  let firstAgenda = '';
  const start = new Date(Date.now() + 2 * 3600_000);

  it('Nadia makes it inviting Sameera: thirteen weeks of meetings, one space, the people on each', async () => {
    const made = await make({
      title: 'Weekly sync',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
      frequency: 'weekly',
      timeZone: 'UTC',
      inviteeIds: [sameera.personId],
      agenda: 'Plans for the week',
    });
    seriesId = made.series.id;
    slug = made.series.folder.split('/').pop()!;
    expect(made.series).toMatchObject({ title: 'Weekly sync', folder: 'meetings/series/weekly-sync', frequency: 'weekly', status: 'active', canEdit: true });
    expect(made.appointment).toMatchObject({ series: { id: seriesId, frequency: 'weekly', status: 'active' }, invited: [{ personId: sameera.personId }] });
    space = made.appointment.channelId;
    const rows = await occurrences(seriesId);
    expect(rows.length).toBe(14);
    const spaces = (await w.system((tx) => tx.query<{ n: string }>('SELECT count(DISTINCT space_channel_id)::text AS n FROM app.appointments WHERE series_id = $1', [seriesId]))).rows[0]!.n;
    expect(spaces).toBe('1');
    const invited = (await w.system((tx) => tx.query<{ n: string }>("SELECT count(*)::text AS n FROM app.appointment_invitees i JOIN app.appointments a ON a.id = i.appointment_id WHERE a.series_id = $1", [seriesId]))).rows[0]!.n;
    expect(invited).toBe('14');
    expect(await members(space)).toEqual([nadia.personId, sameera.personId].sort());
    // told once, not fourteen times
    await eventually(async () => {
      const n = (await w.system((tx) => tx.query<{ n: string }>("SELECT count(*)::text AS n FROM app.notifications WHERE person_id = $1 AND kind = 'appointment_invite' AND ref_id = ANY ($2::uuid[])", [sameera.personId, rows.map((r) => r.id)]))).rows[0]!.n;
      return n === '1' ? true : undefined;
    }, 20_000, 'one invitation');
  });

  it('the team and the invited see the meetings with the series; Tariq does not; the agenda path is for the team only', async () => {
    const from = encodeURIComponent(new Date(start.getTime() - 3600_000).toISOString());
    const to = encodeURIComponent(new Date(start.getTime() + 15 * 86_400_000).toISOString());
    const list = async (who: typeof omar) => ListAppointmentsResponse.parse((await w.call(who, 'GET', `/api/appointments?from=${from}&to=${to}`)).body).appointments.filter((a) => a.series?.id === seriesId);
    // the first agenda is written by the platform's job
    firstAgenda = await eventually(async () => (await occurrences(seriesId))[0]?.agenda_path ?? undefined, 20_000, 'the first agenda');
    expect(firstAgenda).toBe(`meetings/series/${slug}/${start.toISOString().slice(0, 10)}-agenda.md`);
    const forRafi = await list(rafi);
    expect(forRafi).toHaveLength(3);
    expect(forRafi[0]).toMatchObject({ agendaPath: firstAgenda, canEdit: false });
    expect(forRafi[1]!.agendaPath).toBeNull();
    const forSameera = await list(sameera);
    expect(forSameera).toHaveLength(3);
    expect(forSameera[0]!.agendaPath).toBeNull();
    expect(forSameera[0]!.series).toMatchObject({ title: 'Weekly sync' });
    expect(await list(tariq)).toHaveLength(0);
  });

  it('the folder holds the README and the agenda; Nadia edits the agenda, and nothing else under meetings/ is anyone\'s to change', async () => {
    const readme = await read(nadia, `meetings/series/${slug}/README.md`);
    expect(readme.status).toBe(200);
    expect(readme.text).toContain('A meeting series of Engineering: every week.');
    const page = await read(nadia, firstAgenda);
    expect(page.text).toContain('# Weekly sync · ');
    expect(page.text).toContain('- Plans for the week');
    expect(page.text).toContain('*Nothing was left open.*');
    const edited = page.text.replace('## Notes', '- [ ] Send the draft to legal — Priya\n- [x] Book the room\n\n## Notes').replace('- [ ] \n', '');
    const ok = await commit(nadia, [{ op: 'put', path: firstAgenda, content: edited }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await commit(nadia, [{ op: 'put', path: `meetings/series/${slug}/2031-01-07-agenda.md`, content: 'made by hand' }])).status).toBe(403);
    expect((await commit(nadia, [{ op: 'put', path: `meetings/series/${slug}/README.md`, content: 'mine' }])).status).toBe(403);
    expect((await commit(nadia, [{ op: 'delete', path: firstAgenda }])).status).toBe(403);
    expect((await commit(sameera, [{ op: 'put', path: firstAgenda, content: 'from outside the team' }])).status).toBe(403);
  });

  it('an occurrence keeps the series\' people; the series changes them and its space follows', async () => {
    const [first] = await occurrences(seriesId);
    expect((await w.call(nadia, 'PATCH', `/api/appointments/${first!.id}`, { inviteeIds: [tariq.personId] })).status).toBe(409);
    expect((await w.call(rafi, 'PATCH', `/api/meeting-series/${seriesId}`, { inviteeIds: [tariq.personId] })).status).toBe(403);
    const res = await w.call<MeetingSeriesResponse>(nadia, 'PATCH', `/api/meeting-series/${seriesId}`, { inviteeIds: [sameera.personId, tariq.personId] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const people = (await w.system((tx) => tx.query<{ person_id: string }>('SELECT DISTINCT person_id FROM app.appointment_invitees i JOIN app.appointments a ON a.id = i.appointment_id WHERE a.series_id = $1', [seriesId]))).rows.map((r) => r.person_id).sort();
    expect(people).toEqual([sameera.personId, tariq.personId].sort());
    expect(await members(space)).toEqual([nadia.personId, sameera.personId, tariq.personId].sort());
  });

  it('after the first meeting, the next agenda carries the unticked box and the notes\' action item; not the ticked one, not a Personal copy\'s', async () => {
    const [first] = await occurrences(seriesId);
    // two calls in the space: the first with notes the team may read, the second a note-taker's Personal copy
    const notes = async (location: 'channel_files' | 'personal', text: string): Promise<void> => {
      const joined = OpenMeetingSpaceResponse.parse((await w.call(nadia, 'POST', `/api/appointments/${first!.id}/join`)).body);
      await w.system((tx) =>
        tx.query(
          `INSERT INTO app.meeting_notes (meeting_id, workspace_id, organizer_id, location, status, items) VALUES ($1, $2, $3, $4, 'written', $5::jsonb)`,
          [joined.meeting.id, nadia.workspaceId, nadia.actorId, location, JSON.stringify([{ kind: 'action', text, ownerName: 'Rafi', ownerId: null, due: null, atMs: 0 }])],
        ),
      );
      expect((await w.call(nadia, 'POST', `/api/meetings/${joined.meeting.id}/end`)).status).toBe(200);
    };
    await notes('channel_files', 'Write the release notes');
    await notes('personal', 'A private reminder');
    // the first meeting is over: it ended two hours ago
    await w.system((tx) => tx.query("UPDATE app.appointments SET starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' WHERE id = $1", [first!.id]));
    const job = await w.system(async (tx) => (await enqueue(tx, 'meetings.series-agenda', { seriesId, workspaceId: nadia.workspaceId })).id);
    await eventually(async () => ((await w.system((tx) => tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [job]))).rows[0]?.state === 'done' ? true : undefined), 20_000, 'the agenda job');
    const second = (await occurrences(seriesId))[1]!;
    expect(second.agenda_path).not.toBeNull();
    const text = (await read(rafi, second.agenda_path!)).text;
    const carried = text.split('## Open action items from the last meeting\n')[1]!.split('\n\n')[0]!;
    expect(carried.split('\n')).toEqual(['- [ ] Send the draft to legal — Priya', '- [ ] Write the release notes — Rafi']);
    expect(text).not.toContain('Book the room');
    expect(text).not.toContain('A private reminder');
    // the third waits for the second
    expect((await occurrences(seriesId))[2]!.agenda_path).toBeNull();
  });

  it('stopping cancels the meetings to come and keeps the agendas; a stopped series cannot be changed', async () => {
    expect((await w.call(rafi, 'POST', `/api/meeting-series/${seriesId}/stop`)).status).toBe(403);
    const res = await w.call<MeetingSeriesResponse>(omar, 'POST', `/api/meeting-series/${seriesId}/stop`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(MeetingSeriesResponse.parse(res.body).series.status).toBe('stopped');
    const rows = await occurrences(seriesId);
    expect(rows.filter((r) => r.starts_at.getTime() > Date.now()).every((r) => r.status === 'cancelled')).toBe(true);
    expect(rows[0]!.status).toBe('scheduled');
    expect(rows.filter((r) => r.agenda_path !== null)).toHaveLength(2);
    expect((await w.call(nadia, 'PATCH', `/api/meeting-series/${seriesId}`, { title: 'Again' })).status).toBe(409);
    expect((await w.call(nadia, 'POST', `/api/meeting-series/${seriesId}/stop`)).status).toBe(409);
    expect(await plan(seriesId, '2027-12-01T00:00:00Z')).toEqual([]);
    // the planner's pass (as the platform) adds nothing to a stopped series
    const count = (await occurrences(seriesId)).length;
    const job = await w.system(async (tx) => (await enqueue(tx, 'meetings.series-plan', {})).id);
    await eventually(async () => ((await w.system((tx) => tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [job]))).rows[0]?.state === 'done' ? true : undefined), 20_000, 'the plan job');
    expect(await occurrences(seriesId)).toHaveLength(count);
  });
});
