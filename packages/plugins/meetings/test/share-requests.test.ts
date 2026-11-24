import { AskToShareResponse, MEETING_SHARE_ANSWERED_PUSH, MEETING_SHARE_ASKED_PUSH, StartMeetingResponse } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';

// "Ask to share" (P17-02; docs/plugins/meetings.md "Ask to share"): only a person in the live call asks, only someone else in the same call is asked, the push goes to
// that one person and the answer to the asker only; one request per asker and person asked a minute; only the person asked answers, once, within the minute; a yes turns
// down the others waiting for the same person; a request is recorded (an event, and so an audit row) only when it is answered, never when it is asked.

const { omar, nadia, rafi, priya } = personas;

let w: World;
let listen: pg.Client;
const pushed: Array<{ personId: string; type: string; payload: Record<string, unknown> }> = [];
const saved = { provider: process.env['MANYTHREADS_MEDIA_PROVIDER'] };

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  listen = new pg.Client({ connectionString: w.server.db.systemUrl });
  await listen.connect();
  listen.on('notification', (n) => {
    if (n.payload) pushed.push(JSON.parse(n.payload) as (typeof pushed)[number]);
  });
  await listen.query('LISTEN manythreads_realtime');
}, 180_000);
afterAll(async () => {
  await listen?.end().catch(() => undefined);
  await w?.close();
  if (saved.provider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = saved.provider;
});

type Who = typeof omar;
let counter = 0;
/** A fresh open channel of Engineering with a live call that `people` are in (the first started it). */
async function callWith(people: Who[]): Promise<string> {
  const name = `share-${String((counter += 1))}`;
  const channelId = await w.system(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          "INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) SELECT $1, t.id, $2, 'channel', false, $3 FROM app.teams t WHERE t.slug = 'engineering' RETURNING id",
          [omar.workspaceId, name, omar.actorId],
        )
      ).rows[0]!.id,
  );
  const res = await w.call(people[0]!, 'POST', `/api/channels/${channelId}/meetings`, { title: 'Pairing' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const id = StartMeetingResponse.parse(res.body).meeting.id;
  for (const p of people.slice(1)) {
    const j = await w.call(p, 'POST', `/api/meetings/${id}/join`);
    expect(j.status, JSON.stringify(j.body)).toBe(200);
  }
  return id;
}
const ask = (who: Who, meetingId: string, sharer: Who) => w.call(who, 'POST', `/api/meetings/${meetingId}/share-requests`, { sharerActorId: sharer.actorId });
const answer = (who: Who, meetingId: string, requestId: string, a: 'accept' | 'decline') => w.call(who, 'POST', `/api/meetings/${meetingId}/share-requests/${requestId}/answer`, { answer: a });
const eventsFor = (type: string, meetingId: string) =>
  w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = $1 AND payload->>'meetingId' = $2 ORDER BY id", [type, meetingId])).rows.map((r) => r.payload));
const pushesFor = (type: string, meetingId: string) => pushed.filter((p) => p.type === type && p.payload['meetingId'] === meetingId);

describe('asking the person sharing for a turn', () => {
  it('tells only the person asked, with the asker\'s name and a minute to answer; one request waits per asker', async () => {
    const m = await callWith([nadia, rafi, priya]);
    const res = await ask(rafi, m, nadia);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { requestId, expiresAt } = AskToShareResponse.parse(res.body);
    const left = Date.parse(expiresAt) - Date.now();
    expect(left).toBeGreaterThan(50_000);
    expect(left).toBeLessThanOrEqual(61_000);
    const got = await eventually(async () => (pushesFor(MEETING_SHARE_ASKED_PUSH, m).length > 0 ? pushesFor(MEETING_SHARE_ASKED_PUSH, m) : undefined), 5_000, 'the push to Nadia');
    expect(got.map((p) => p.personId)).toEqual([nadia.personId]);
    expect(got[0]!.payload).toMatchObject({ requestId, askerActorId: rafi.actorId, askerName: expect.stringMatching(/Rafi/) as unknown });
    // asked, not answered: nothing is recorded (the person asked may not even be sharing)
    expect(await eventsFor('meetings.share_request.answered', m)).toEqual([]);

    // a second press within the minute is refused; asking someone else replaces it
    const again = await ask(rafi, m, nadia);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain('less than a minute ago');
    const other = await ask(rafi, m, priya);
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const rows = await w.system(async (tx) => (await tx.query<{ sharer_id: string }>('SELECT sharer_id FROM app.meeting_share_requests WHERE meeting_id = $1', [m])).rows);
    expect(rows).toEqual([{ sharer_id: priya.actorId }]);
  });

  it('refuses someone not in the call, asking oneself, and asking someone who is not in the call', async () => {
    const m = await callWith([nadia, rafi]);
    // Omar can read the channel but is not in the call
    expect((await ask(omar, m, nadia)).status).toBe(403);
    expect((await ask(nadia, m, nadia)).status).toBe(409);
    expect((await ask(rafi, m, priya)).status).toBe(409);
    // someone who left is out too
    expect((await w.call(rafi, 'POST', `/api/meetings/${m}/leave`)).status).toBe(200);
    expect((await ask(rafi, m, nadia)).status).toBe(403);
    expect(pushesFor(MEETING_SHARE_ASKED_PUSH, m)).toEqual([]);
    expect(await eventsFor('meetings.share_request.answered', m)).toEqual([]);
  });

  it('a call that has ended takes no request', async () => {
    const m = await callWith([nadia, rafi]);
    expect((await w.call(nadia, 'POST', `/api/meetings/${m}/end`)).status).toBe(200);
    expect([403, 409]).toContain((await ask(rafi, m, nadia)).status);
  });
});

describe('answering a request', () => {
  it('only the person asked answers, once; the asker alone is told, and the answer is an event', async () => {
    const m = await callWith([nadia, rafi, priya]);
    const { requestId } = AskToShareResponse.parse((await ask(rafi, m, nadia)).body);
    // the asker, a bystander in the call and someone outside it cannot answer for Nadia
    expect((await answer(rafi, m, requestId, 'accept')).status).toBe(404);
    expect((await answer(priya, m, requestId, 'accept')).status).toBe(404);
    expect((await answer(omar, m, requestId, 'accept')).status).toBe(404);

    const res = await answer(nadia, m, requestId, 'accept');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ answer: 'accept' });
    const told = await eventually(async () => (pushesFor(MEETING_SHARE_ANSWERED_PUSH, m).length > 0 ? pushesFor(MEETING_SHARE_ANSWERED_PUSH, m) : undefined), 5_000, 'the push to Rafi');
    expect(told.map((p) => p.personId)).toEqual([rafi.personId]);
    expect(told[0]!.payload).toMatchObject({ requestId, sharerActorId: nadia.actorId, answer: 'accept' });
    expect(await eventsFor('meetings.share_request.answered', m)).toEqual([expect.objectContaining({ requestId, answeredBy: nadia.actorId, askedBy: rafi.actorId, answer: 'accept' })]);

    // answered once
    const twice = await answer(nadia, m, requestId, 'decline');
    expect(twice.status).toBe(409);
    // a request of this call under another call's id is not there
    const other = await callWith([priya, omar]);
    expect((await answer(nadia, other, requestId, 'decline')).status).toBe(404);
  });

  it('"Not now" is told to the asker, who may ask the same person again only after a minute', async () => {
    const m = await callWith([nadia, rafi]);
    const { requestId } = AskToShareResponse.parse((await ask(rafi, m, nadia)).body);
    expect((await answer(nadia, m, requestId, 'decline')).status).toBe(200);
    await eventually(async () => (pushesFor(MEETING_SHARE_ANSWERED_PUSH, m).some((p) => p.payload['answer'] === 'decline') ? true : undefined), 5_000, 'the decline push');
    expect(await eventsFor('meetings.share_request.answered', m)).toEqual([expect.objectContaining({ requestId, answer: 'decline' })]);
    expect((await ask(rafi, m, nadia)).status).toBe(409);
    await w.system(async (tx) => void (await tx.query("UPDATE app.meeting_share_requests SET asked_at = now() - interval '61 seconds' WHERE id = $1", [requestId])));
    expect((await ask(rafi, m, nadia)).status).toBe(201);
  });

  it('a yes turns down the other requests waiting for the same person: each asker is told "other", oldest first, and is recorded', async () => {
    const m = await callWith([nadia, rafi, priya, omar]);
    const first = AskToShareResponse.parse((await ask(rafi, m, nadia)).body).requestId;
    const second = AskToShareResponse.parse((await ask(priya, m, nadia)).body).requestId;
    const third = AskToShareResponse.parse((await ask(omar, m, nadia)).body).requestId;
    expect((await answer(nadia, m, second, 'accept')).status).toBe(200);
    const told = await eventually(async () => (pushesFor(MEETING_SHARE_ANSWERED_PUSH, m).length >= 3 ? pushesFor(MEETING_SHARE_ANSWERED_PUSH, m) : undefined), 5_000, 'three answers');
    expect(told.map((p) => [p.personId, p.payload['answer']])).toEqual([
      [priya.personId, 'accept'],
      [rafi.personId, 'other'],
      [omar.personId, 'other'],
    ]);
    expect((await eventsFor('meetings.share_request.answered', m)).map((e) => [e['requestId'], e['answer']])).toEqual([
      [second, 'accept'],
      [first, 'other'],
      [third, 'other'],
    ]);
    // nothing is left waiting, so nobody's request blocks them from asking the next sharer
    const waiting = await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.meeting_share_requests WHERE meeting_id = $1 AND state = 'pending'", [m])).rows.length);
    expect(waiting).toBe(0);
    // the ones turned down cannot be accepted afterwards
    expect((await answer(nadia, m, third, 'accept')).status).toBe(409);
    expect((await ask(rafi, m, priya)).status).toBe(201);
  });

  it('a request older than a minute cannot be answered, and a new one may be sent', async () => {
    const m = await callWith([nadia, rafi]);
    const { requestId } = AskToShareResponse.parse((await ask(rafi, m, nadia)).body);
    await w.system(async (tx) => void (await tx.query("UPDATE app.meeting_share_requests SET expires_at = now() - interval '1 second', asked_at = now() - interval '61 seconds' WHERE id = $1", [requestId])));
    const late = await answer(nadia, m, requestId, 'accept');
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.body)).toContain('timed out');
    expect(pushesFor(MEETING_SHARE_ANSWERED_PUSH, m)).toEqual([]);
    expect((await ask(rafi, m, nadia)).status).toBe(201);
  });
});
