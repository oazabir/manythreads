import { type ChannelId, DirectMessageSummary, ListDmsResponse, OpenDmResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from '../../channels/test/world.ts';

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;

let w: World;
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const open = (who: Persona | null, ...others: Persona[]): Promise<ApiResult> =>
  w.call(who, 'POST', '/api/dms', { personIds: others.map((o) => o.personId) });
const opened = async (who: Persona, ...others: Persona[]): Promise<OpenDmResponse> => {
  const res = await open(who, ...others);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return OpenDmResponse.parse(res.body);
};
const dmRows = (): Promise<Array<{ id: string; dm_key: string; members: number }>> =>
  w.system(async (tx) => (await tx.query<{ id: string; dm_key: string; members: number }>(
    `SELECT c.id, c.dm_key, (SELECT count(*)::int FROM app.channel_members m WHERE m.channel_id = c.id) AS members
       FROM app.channels c WHERE c.kind = 'dm' ORDER BY c.dm_key`)).rows);
const send = (who: Persona, channelId: string, body: string): Promise<ApiResult> =>
  w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
const list = async (who: Persona, query = ''): Promise<ListDmsResponse> => {
  const res = await w.call(who, 'GET', `/api/dms${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListDmsResponse.parse(res.body);
};

describe('POST /api/dms: get-or-create (criterion 5)', () => {
  it('makes the DM once (201) and finds it again (200), whoever opens it and in whatever order the people are named', async () => {
    const first = await opened(nadia, rafi);
    expect(first.created).toBe(true);
    const channel = first.dm.channel;
    expect(channel).toMatchObject({ kind: 'dm', private: true, teamId: null, name: '', archivedAt: null });
    expect(channel.dmKey).toBe([nadia.personId, rafi.personId].sort().join(','));
    expect(first.dm.participants.map((p) => p.personId).sort()).toEqual([nadia.personId, rafi.personId].sort());
    expect(first.dm.participants.map((p) => p.displayName).sort()).toEqual(['Nadia', 'Rafi']);
    expect(first.dm).toMatchObject({ lastMessage: null, unreadCount: 0 });
    const again = await opened(nadia, rafi);
    expect(again).toMatchObject({ created: false });
    expect(again.dm.channel.id).toBe(channel.id);
    expect((await opened(rafi, nadia)).dm.channel.id).toBe(channel.id);                // from the other side
    expect((await opened(nadia, rafi, nadia)).dm.channel.id).toBe(channel.id);          // naming yourself too changes nothing
    expect((await open(nadia, rafi)).status).toBe(200);
    expect((await dmRows()).filter((r) => r.dm_key === channel.dmKey)).toEqual([{ id: channel.id, dm_key: channel.dmKey, members: 2 }]);
  });

  it('ten concurrent opens, from both sides, make one row with both members (Promise.all)', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? open(priya, omar) : open(omar, priya))),
    );
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const parsed = results.map((r) => OpenDmResponse.parse(r.body));
    expect(new Set(parsed.map((p) => p.dm.channel.id)).size).toBe(1);
    expect(parsed.filter((p) => p.created)).toHaveLength(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const key = [priya.personId, omar.personId].sort().join(',');
    expect((await dmRows()).filter((r) => r.dm_key === key)).toEqual([{ id: parsed[0]!.dm.channel.id, dm_key: key, members: 2 }]);
  });

  it('a group of three is its own conversation, the same whatever the order', async () => {
    const a = await opened(nadia, rafi, priya);
    expect(a.created).toBe(true);
    expect(a.dm.participants).toHaveLength(3);
    const b = await opened(priya, rafi, nadia);
    expect(b.dm.channel.id).toBe(a.dm.channel.id);
    expect(b.created).toBe(false);
    expect(a.dm.channel.id).not.toBe((await opened(nadia, rafi)).dm.channel.id);
  });

  it('refuses a guest (403), a guest as the other person, an unknown person, an empty or too large list, and no sign-in', async () => {
    expect((await open(lena, nadia)).status).toBe(403);
    expect((await open(nadia, lena)).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/dms', { personIds: ['00000000-0000-7000-8000-0000000c0099'] })).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/dms', { personIds: [] })).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId], extra: 1 })).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/dms', { personIds: Array.from({ length: 9 }, () => rafi.personId) })).status).toBe(400);
    expect((await open(null, rafi)).status).toBe(401);
    expect((await dmRows()).every((r) => !r.dm_key.includes(lena.personId))).toBe(true);
  });

  it('a suspended person cannot be messaged, and cannot message', async () => {
    await w.system((tx) => tx.query("UPDATE app.people SET status = 'suspended' WHERE id = $1", [tariq.personId]));
    try {
      expect((await open(nadia, tariq)).status).toBe(400);
      expect((await open(tariq, nadia)).status).toBe(403);
    } finally {
      await w.system((tx) => tx.query("UPDATE app.people SET status = 'active' WHERE id = $1", [tariq.personId]));
    }
  });
});

describe('direct messages are private', () => {
  let dm = '' as ChannelId;
  beforeAll(async () => {
    dm = (await opened(nadia, rafi)).dm.channel.id;
    expect((await send(nadia, dm, 'Check the rota?')).status).toBe(201);
  });

  it('only the people in it read or write it: not a workspace admin, not another member, not a guest', async () => {
    for (const outsider of [omar, sameera, priya, lena]) {
      expect((await w.call(outsider, 'GET', `/api/channels/${dm}/messages`)).status, outsider.key).toBe(403);
      expect((await w.call(outsider, 'GET', `/api/channels/${dm}`)).status, outsider.key).toBe(403);
      expect((await send(outsider, dm, 'hello?')).status, outsider.key).toBe(403);
    }
    expect((await w.call(rafi, 'GET', `/api/channels/${dm}/messages`)).status).toBe(200);
    // The database agrees: the channel row itself is invisible to the admin, and nobody can add themselves.
    const rows = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.channel_members WHERE channel_id = $1', [dm])).rows.length);
    expect(rows).toBe(2);
    expect((await w.call(omar, 'POST', `/api/channels/${dm}/members`, { personId: omar.personId })).status).toBe(403);
    expect((await w.call(nadia, 'POST', `/api/channels/${dm}/leave`)).status).toBeGreaterThanOrEqual(400);
  });

  it('the admin who opens a DM with the same person gets another conversation, not this one', async () => {
    const other = await opened(omar, rafi);
    expect(other.dm.channel.id).not.toBe(dm);
  });

  it('GET /api/dms lists only my conversations with the last message and my unread, most recent first', async () => {
    const mine = await list(rafi);
    const row = mine.items.find((i) => i.channel.id === dm)!;
    expect(row.unreadCount).toBe(1);
    expect(row.lastMessage).toMatchObject({ preview: 'Check the rota?' });
    expect(row.lastMessage?.authorId).toBe(nadia.actorId);
    expect(mine.items.every((i) => i.participants.some((p) => p.personId === rafi.personId))).toBe(true);
    expect((await list(nadia)).items.find((i) => i.channel.id === dm)?.unreadCount).toBe(0);   // her own message is not unread for her
    expect((await list(sameera)).items).toEqual([]);
    expect((await list(lena)).items).toEqual([]);
    expect((await list(omar)).items.some((i) => i.channel.id === dm)).toBe(false);

    // A newer message in another DM moves it first; the cursor continues the list.
    const second = (await opened(rafi, priya)).dm.channel.id;
    await send(priya, second, 'ping');
    const ids = (await list(rafi)).items.map((i) => i.channel.id);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(dm));
    const page1 = await list(rafi, '?limit=1');
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await list(rafi, `?limit=1&cursor=${page1.nextCursor}`);
    expect(page2.items[0]?.channel.id).not.toBe(page1.items[0]?.channel.id);
    expect((await w.call(rafi, 'GET', '/api/dms?cursor=nope')).status).toBe(400);
    expect((await w.call(null, 'GET', '/api/dms')).status).toBe(401);
  });

  it('the conversation can carry threads like any channel', async () => {
    const root = (await send(nadia, dm, 'a thread in a DM')).body as { id: string };
    const reply = await w.call(rafi, 'POST', `/api/channels/${dm}/messages`, { channelId: dm, body: 'reply', threadRootId: root.id });
    expect(reply.status).toBe(201);
    expect((await w.call(nadia, 'GET', `/api/threads/${root.id}`)).status).toBe(200);
    expect((await w.call(omar, 'GET', `/api/threads/${root.id}`)).status).toBe(403);
    expect(DirectMessageSummary.safeParse((await list(nadia)).items[0]).success).toBe(true);
  });
});
