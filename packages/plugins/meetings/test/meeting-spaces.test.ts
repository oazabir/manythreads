import { OpenMeetingSpaceResponse } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// P36-03 through the real server: Nadia (Engineering) opens a meeting for Engineering inviting Sameera (Customer support); it is a team-less private channel of
// kind `meeting` that Sameera reads and finds in her list, with its call live; Tariq (not invited) and a guest cannot read it; a guest cannot be invited, a team
// the opener is not on is refused, and a video meeting is video.

const { omar, nadia, sameera, tariq, lena } = personas;

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

const open = (who: typeof omar, body: Record<string, unknown>) => w.call<OpenMeetingSpaceResponse & { error?: { message: string } }>(who, 'POST', '/api/meetings/spaces', body);

describe('meetings without a channel (P36-03)', () => {
  let space = '';

  it('opens a team-less private meeting with people of another team, and starts its call', async () => {
    const res = await open(nadia, { title: 'Escalation review', teamSlug: 'engineering', inviteeIds: [sameera.personId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = OpenMeetingSpaceResponse.parse(res.body);
    space = body.channelId;
    expect(body).toMatchObject({ created: true, meeting: { channelId: space, title: 'Escalation review', kind: 'audio' }, invited: 1 });
    const ch = (await w.system((tx) => tx.query<{ kind: string; team_id: string | null; private: boolean; purpose: string }>('SELECT kind, team_id, private, purpose FROM app.channels WHERE id = $1', [space]))).rows[0];
    expect(ch).toEqual({ kind: 'meeting', team_id: null, private: true, purpose: 'Escalation review' });
    const members = (await w.system((tx) => tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_members WHERE channel_id = $1 ORDER BY person_id', [space]))).rows.map((r) => r.person_id);
    expect(members.sort()).toEqual([nadia.personId, sameera.personId].sort());
  });

  it('the invited person from another team reads it and finds it in her list with its call live; someone not invited and a guest do not', async () => {
    expect((await w.call(sameera, 'GET', `/api/channels/${space}`)).status).toBe(200);
    const list = await w.call<{ spaces: Array<{ channelId: string; title: string; memberCount: number; liveMeetingId: string | null }> }>(sameera, 'GET', '/api/meetings/spaces');
    expect(list.body.spaces.find((s) => s.channelId === space)).toMatchObject({ title: 'Escalation review', memberCount: 2, liveMeetingId: expect.any(String) });
    expect((await w.call(tariq, 'GET', `/api/channels/${space}`)).status).toBe(403);
    expect((await w.call<{ spaces: unknown[] }>(tariq, 'GET', '/api/meetings/spaces')).body.spaces).toEqual([]);
    expect((await w.call(lena, 'GET', `/api/channels/${space}`)).status).toBe(403);
    // she may post in it, as in any conversation she is in
    expect((await w.call(sameera, 'POST', `/api/channels/${space}/messages`, { channelId: space, body: 'Joining in a minute', threadRootId: null })).status).toBe(201);
  });

  it('refuses a guest as an invitee, a team the opener is not on, and an empty title; a video meeting is video', async () => {
    expect((await open(nadia, { title: 'With a guest', teamSlug: 'engineering', inviteeIds: [lena.personId] })).status).toBe(400);
    expect((await open(nadia, { title: 'Not my team', teamSlug: 'marketing', inviteeIds: [] })).status).toBe(403);
    expect((await open(nadia, { title: '', teamSlug: 'engineering', inviteeIds: [] })).status).toBe(400);
    const video = await open(nadia, { title: 'Face to face', teamSlug: 'engineering', kind: 'video', inviteeIds: [omar.personId] });
    expect(video.status).toBe(201);
    expect(OpenMeetingSpaceResponse.parse(video.body).meeting.kind).toBe('video');
  });

  it('lists who can be invited across teams by name, leaving out guests and the caller', async () => {
    const all = await w.call<{ people: Array<{ personId: string; name: string }> }>(nadia, 'GET', '/api/meetings/people');
    expect(all.status).toBe(200);
    const ids = all.body.people.map((p) => p.personId);
    expect(ids).toContain(sameera.personId);
    expect(ids).toContain(tariq.personId);
    expect(ids).not.toContain(lena.personId);
    expect(ids).not.toContain(nadia.personId);
    const some = await w.call<{ people: Array<{ personId: string }> }>(nadia, 'GET', '/api/meetings/people?q=sam');
    expect(some.body.people.map((p) => p.personId)).toEqual([sameera.personId]);
  });
});
