import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import {
  EndMeetingResponse,
  GetMeetingResponse,
  JoinMeetingResponse,
  LeaveMeetingResponse,
  ListMeetingsResponse,
  MEDIA_TOKEN_MAX_SECONDS,
  MediaStatusResponse,
  OpenDmResponse,
  StartMeetingResponse,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';

// Voice rooms over the API with the deterministic fake media provider (PLAN P15-03): get-or-create, who may start, join, leave and end, the call thread, the
// token's lifetime, the 2-minute auto-end, the kick when a person loses the channel, and the per-person limit on starts.

const { omar, nadia, rafi, sameera, tariq, lena } = personas;

let w: World;
let general: string;
const originalProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld();
  await ensureChannels(w);
  general = await w.channelId('engineering', 'general');
}, 180_000);
afterAll(async () => {
  await w?.close();
  if (originalProvider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = originalProvider;
});

const start = (who: typeof omar | null, channelId: string, body: unknown = {}) => w.call(who, 'POST', `/api/channels/${channelId}/meetings`, body);
const meetingRow = (id: string) =>
  w.system(async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM app.meetings WHERE id = $1', [id])).rows[0]);
const presentIds = (id: string) =>
  w.system(async (tx) => (await tx.query<{ actor_id: string }>('SELECT actor_id FROM app.meeting_participants WHERE meeting_id = $1 AND left_at IS NULL ORDER BY actor_id', [id])).rows.map((r) => r.actor_id));
const events = (type: string) =>
  w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));

describe('media status', () => {
  it('says the fake provider is ready', async () => {
    const res = await w.call(nadia, 'GET', '/api/meetings/media-status');
    expect(res.status).toBe(200);
    expect(MediaStatusResponse.parse(res.body)).toEqual({ configured: true, provider: 'fake', reason: null });
  });
});

describe('start: one live room per channel, get or create', () => {
  let first: StartMeetingResponse;

  it('opens a room with a default title, joins the starter, makes a token under ten minutes and a chat thread', async () => {
    const res = await start(nadia, general);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    first = StartMeetingResponse.parse(res.body);
    expect(first.created).toBe(true);
    expect(first.meeting).toMatchObject({ state: 'live', channelId: general, startedBy: nadia.actorId, organizerId: nadia.actorId, endedAt: null, transcription: 'off', recording: false });
    expect(first.meeting.title).toMatch(/^Voice room \u00b7 \d\d:\d\d$/);
    expect(first.join.identity).toBe(nadia.actorId);
    expect(first.join.roomName).toBe(first.meeting.id);
    const lifetime = (new Date(first.join.expiresAt).getTime() - Date.now()) / 1000;
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(MEDIA_TOKEN_MAX_SECONDS);
    // the token carries what the provider was asked for: audio both ways for a person
    const claims = lastFakeMedia().decode(first.join.token)!;
    expect(claims).toMatchObject({ identity: nadia.actorId, room: first.meeting.id, canPublish: true, canSubscribe: true, listenOnly: false });
    expect(lastFakeMedia().rooms.has(first.meeting.id)).toBe(true);
    expect(await presentIds(first.meeting.id)).toEqual([nadia.actorId]);
    // the call thread: a message in the channel that the room points at
    expect(first.meeting.threadRootId).not.toBeNull();
    const root = await w.system(async (tx) => (await tx.query<{ channel_id: string; body: string }>('SELECT channel_id, body FROM app.messages WHERE id = $1', [first.meeting.threadRootId])).rows[0]);
    expect(root?.channel_id).toBe(general);
  });

  it('a second start (another person, or the same one again) comes back with the same room and does not make another', async () => {
    const again = StartMeetingResponse.parse((await start(rafi, general, { title: 'Ignored title' })).body);
    expect(again.created).toBe(false);
    expect(again.meeting.id).toBe(first.meeting.id);
    expect(again.meeting.title).toBe(first.meeting.title);
    const count = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.meetings WHERE channel_id = $1 AND state = 'live'", [general])).rows[0]!.n);
    expect(count).toBe(1);
    expect((await presentIds(first.meeting.id)).sort()).toEqual([nadia.actorId, rafi.actorId].sort());
  });

  it('two starts at the same moment still end in one room', async () => {
    const channel = await w.channelId('engineering', 'dev');
    const results = await Promise.all([start(omar, channel), start(nadia, channel), start(rafi, channel)]);
    const rooms = new Set(results.map((r) => StartMeetingResponse.parse(r.body).meeting.id));
    expect(rooms.size).toBe(1);
    expect(results.filter((r) => StartMeetingResponse.parse(r.body).created).length).toBe(1);
  });

  it('refuses a person who cannot post in the channel, a guest, and no one at all', async () => {
    expect((await start(sameera, general)).status).toBe(403);
    expect((await start(lena, general)).status).toBe(403);
    expect((await start(null, general)).status).toBe(401);
  });

  it('refuses a title with a line break, and a made-up channel', async () => {
    expect((await start(omar, general, { title: 'two\nlines' })).status).toBe(400);
    expect((await start(omar, '00000000-0000-7000-8000-00000000ffff')).status).toBe(403);
  });

  it('writes the started and joined events with ids only (never the title)', async () => {
    const started = (await events('meetings.meeting.started')).filter((p) => p['meetingId'] === first.meeting.id);
    expect(started).toHaveLength(1);
    expect(JSON.stringify(started[0])).not.toContain(first.meeting.title);
    const joined = (await events('meetings.participant.joined')).filter((p) => p['meetingId'] === first.meeting.id);
    expect(joined.map((p) => p['actorId']).sort()).toEqual([nadia.actorId, rafi.actorId].sort());
  });
});

describe('read and join', () => {
  it('people who can read the channel see the room and may join; others see nothing', async () => {
    const live = ListMeetingsResponse.parse((await w.call(omar, 'GET', '/api/teams/engineering/meetings')).body);
    const room = live.meetings.find((m) => m.meeting.channelId === general)!;
    expect(room.present.map((p) => p.displayName).sort()).toEqual(['Nadia', 'Rafi']);
    expect(GetMeetingResponse.parse((await w.call(omar, 'GET', `/api/meetings/${room.meeting.id}`)).body).meeting.id).toBe(room.meeting.id);

    const joined = JoinMeetingResponse.parse((await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/join`)).body);
    expect(joined.join.identity).toBe(omar.actorId);
    // joining again changes nothing
    expect((await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/join`)).status).toBe(200);
    expect((await presentIds(room.meeting.id)).length).toBe(3);

    for (const outsider of [sameera, lena]) {
      expect((await w.call(outsider, 'GET', `/api/meetings/${room.meeting.id}`)).status).toBe(404);
      expect((await w.call(outsider, 'POST', `/api/meetings/${room.meeting.id}/join`)).status).toBe(404);
    }
    expect((await w.call(sameera, 'GET', '/api/teams/engineering/meetings')).status).toBe(403);
    const mine = ListMeetingsResponse.parse((await w.call(sameera, 'GET', '/api/meetings/live')).body);
    expect(mine.meetings.find((m) => m.meeting.id === room.meeting.id)).toBeUndefined();
  });

  it('renews the token only for someone in the room', async () => {
    const room = ListMeetingsResponse.parse((await w.call(omar, 'GET', '/api/teams/engineering/meetings')).body).meetings.find((m) => m.meeting.channelId === general)!;
    const renewed = await w.call(nadia, 'POST', `/api/meetings/${room.meeting.id}/token`);
    expect(renewed.status).toBe(200);
    const stranger = await w.call(sameera, 'POST', `/api/meetings/${room.meeting.id}/token`);
    expect(stranger.status).toBe(404);
    await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/leave`);
    expect((await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/token`)).status).toBe(409);
  });

  it('a heartbeat is taken from someone in the room only', async () => {
    const room = ListMeetingsResponse.parse((await w.call(omar, 'GET', '/api/teams/engineering/meetings')).body).meetings.find((m) => m.meeting.channelId === general)!;
    expect((await w.call(nadia, 'POST', `/api/meetings/${room.meeting.id}/heartbeat`, { speaking: true })).status).toBe(200);
    expect((await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/heartbeat`, {})).status).toBe(409);
  });
});

describe('a call in a direct message', () => {
  it('is for the two people only: no team, hidden from everybody else', async () => {
    const dm = OpenDmResponse.parse((await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] })).body).dm.channel.id;
    const room = StartMeetingResponse.parse((await start(nadia, dm)).body);
    expect(room.meeting.teamId).toBeNull();
    expect((await w.call(rafi, 'POST', `/api/meetings/${room.meeting.id}/join`)).status).toBe(200);
    expect((await w.call(omar, 'GET', `/api/meetings/${room.meeting.id}`)).status).toBe(404);
    expect((await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/end`)).status).toBe(404);
    const inLive = (who: typeof omar) => w.call(who, 'GET', '/api/meetings/live').then((r) => ListMeetingsResponse.parse(r.body).meetings.some((m) => m.meeting.id === room.meeting.id));
    expect(await inLive(rafi)).toBe(true);
    expect(await inLive(omar)).toBe(false);
    expect((await w.call(nadia, 'POST', `/api/meetings/${room.meeting.id}/end`)).status).toBe(200);
  });
});

describe('leave and end', () => {
  it('only the starter, a lead of the team or an admin ends a room', async () => {
    const room = StartMeetingResponse.parse((await start(rafi, await w.channelId('engineering', 'standup'))).body);
    // a plain member who did not start it cannot end it
    await w.call(nadia, 'POST', `/api/meetings/${room.meeting.id}/join`);
    const denied = await w.call(nadia, 'POST', `/api/meetings/${room.meeting.id}/end`);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect((await meetingRow(room.meeting.id))?.['state']).toBe('live');
    // the lead (Omar) ends it, whoever started it
    const ended = EndMeetingResponse.parse((await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/end`)).body);
    expect(ended.meeting).toMatchObject({ state: 'ended', endReason: 'person' });
    expect(ended.meeting.endedAt).not.toBeNull();
    expect(lastFakeMedia().closed).toContain(room.meeting.id);
    // an ended room takes no one, ending twice is fine, and a new start opens a new meeting
    expect((await w.call(nadia, 'POST', `/api/meetings/${room.meeting.id}/join`)).status).toBe(409);
    expect((await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/end`)).status).toBe(200);
    const next = StartMeetingResponse.parse((await start(nadia, room.meeting.channelId!)).body);
    expect(next.created).toBe(true);
    expect(next.meeting.id).not.toBe(room.meeting.id);
    const endedEvents = (await events('meetings.meeting.ended')).filter((p) => p['meetingId'] === room.meeting.id);
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]).toMatchObject({ reason: 'person', endedBy: omar.actorId });
  });

  it('closes itself two minutes after the last person left (and not before)', async () => {
    const room = StartMeetingResponse.parse((await start(omar, await w.channelId('engineering', 'releases'))).body);
    // everyone leaves
    for (const actor of await presentIds(room.meeting.id)) {
      const who = [omar, nadia, rafi].find((p) => p.actorId === actor)!;
      const left = LeaveMeetingResponse.parse((await w.call(who, 'POST', `/api/meetings/${room.meeting.id}/leave`)).body);
      expect(left.meeting.state).toBe('live');
    }
    const empty = await meetingRow(room.meeting.id);
    expect(empty?.['state']).toBe('live');
    expect(empty?.['empty_since']).not.toBeNull();
    // the sweep runs, but two minutes have not passed
    const runSweep = async (): Promise<void> => {
      await w.system(async (tx) => void (await tx.query("INSERT INTO app.jobs (queue, payload, run_at) VALUES ('meetings.sweep', '{}'::jsonb, now())")));
    };
    await runSweep();
    await new Promise((r) => setTimeout(r, 1500));
    expect((await meetingRow(room.meeting.id))?.['state']).toBe('live');
    // someone comes back: the clock stops
    await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/join`);
    expect((await meetingRow(room.meeting.id))?.['empty_since']).toBeNull();
    await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/leave`);
    // two minutes pass (the database clock is the only one that counts)
    await w.system(async (tx) => void (await tx.query("UPDATE app.meetings SET empty_since = now() - interval '121 seconds' WHERE id = $1", [room.meeting.id])));
    await runSweep();
    const row = await eventually(async () => {
      const r = await meetingRow(room.meeting.id);
      return r?.['state'] === 'ended' ? r : undefined;
    }, 20_000, 'the room to end by itself');
    expect(row['end_reason']).toBe('empty');
    expect(row['ended_by']).toBeNull();
    expect(lastFakeMedia().closed).toContain(room.meeting.id);
  });

  it('counts a person silent for three minutes as gone', async () => {
    const room = StartMeetingResponse.parse((await start(nadia, await w.channelId('engineering', 'incidents'))).body);
    await w.call(nadia, 'POST', `/api/meetings/${room.meeting.id}/heartbeat`, {});
    await w.system(async (tx) => void (await tx.query("UPDATE app.meeting_presence SET seen_at = now() - interval '181 seconds' WHERE meeting_id = $1", [room.meeting.id])));
    await w.system(async (tx) => void (await tx.query("INSERT INTO app.jobs (queue, payload, run_at) VALUES ('meetings.sweep', '{}'::jsonb, now())")));
    await eventually(async () => ((await presentIds(room.meeting.id)).length === 0 ? true : undefined), 20_000, 'the silent person to be dropped');
    const left = (await events('meetings.participant.left')).filter((p) => p['meetingId'] === room.meeting.id);
    expect(left.map((p) => p['how'])).toContain('dropped');
    await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/end`);
  });
});

describe('losing the channel takes a person out within seconds', () => {
  it('drops a person removed from the team, tells the media server, and gives no new token', async () => {
    const channel = await w.channelId('engineering', 'general');
    const room = StartMeetingResponse.parse((await start(omar, channel)).body);
    expect(room.created).toBe(false);
    expect((await w.call(rafi, 'POST', `/api/meetings/${room.meeting.id}/join`)).status).toBe(200);
    const removedAt = Date.now();
    const res = await w.call(omar, 'DELETE', `/api/teams/engineering/members/${rafi.personId}`);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await eventually(async () => (!(await presentIds(room.meeting.id)).includes(rafi.actorId) ? true : undefined), 5_000, 'the removed person to be dropped');
    expect(Date.now() - removedAt).toBeLessThan(5_000);
    expect(lastFakeMedia().kicked).toContainEqual({ room: room.meeting.id, identity: rafi.actorId });
    expect((await w.call(rafi, 'POST', `/api/meetings/${room.meeting.id}/token`)).status).toBe(404);
    expect((await w.call(rafi, 'POST', `/api/meetings/${room.meeting.id}/join`)).status).toBe(404);
    const left = (await events('meetings.participant.left')).filter((p) => p['meetingId'] === room.meeting.id && p['actorId'] === rafi.actorId);
    expect(left.map((p) => p['how'])).toEqual(['kicked']);
  });
});

describe('media server notices', () => {
  it('are believed only with a valid signature', async () => {
    const forged = await fetch(`${w.server.url}/api/meetings/media-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'room_finished', room: '00000000-0000-7000-8000-000000000001' }) });
    expect(forged.status).toBe(401);
    const wrong = await fetch(`${w.server.url}/api/meetings/media-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': 'deadbeef' }, body: '{}' });
    expect(wrong.status).toBe(401);
  });

  it('a signed participant_left marks the person as gone; a signed participant_joined for someone not in the room kicks them', async () => {
    const { signFakeWebhook } = await import('@manythreads/sdk');
    const room = StartMeetingResponse.parse((await start(nadia, await w.channelId('engineering', 'alerts'))).body);
    const send = (body: Record<string, unknown>) => {
      const raw = JSON.stringify(body);
      return fetch(`${w.server.url}/api/meetings/media-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fake-signature': signFakeWebhook(raw) }, body: raw });
    };
    expect((await send({ id: 'e1', kind: 'participant_left', room: room.meeting.id, identity: nadia.actorId })).status).toBe(200);
    await eventually(async () => ((await presentIds(room.meeting.id)).length === 0 ? true : undefined), 10_000, 'the notice to be applied');
    const before = lastFakeMedia().kicked.length;
    expect((await send({ id: 'e2', kind: 'participant_joined', room: room.meeting.id, identity: sameera.actorId })).status).toBe(200);
    await eventually(async () => (lastFakeMedia().kicked.length > before ? true : undefined), 10_000, 'the stranger to be kicked');
    expect(await presentIds(room.meeting.id)).toEqual([]);
    await w.call(omar, 'POST', `/api/meetings/${room.meeting.id}/end`);
  });
});

describe('the per-person limit on starts', () => {
  it('answers 429 with retry-after past ten starts in a minute', async () => {
    const statuses: number[] = [];
    let last: Response | null = null;
    for (let i = 0; i < 12; i++) {
      last = await fetch(`${w.server.url}/api/channels/${general}/meetings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: tariq.actorId, workspaceId: tariq.workspaceId }) },
        body: '{}',
      });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});
