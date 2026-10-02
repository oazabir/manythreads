import { expect, test } from '@playwright/test';
import { OpenDmResponse, ListDmsResponse } from '@manythreads/shared';
import { personas, type Persona } from '@manythreads/test-utils';

/**
 * Opening the same direct message twice, even concurrently, makes one row (PLAN criterion 5, spec e2e/dm/get-or-create.spec.ts, API
 * level), and a DM is private to the people in it (a workspace admin cannot read it, a guest cannot open one).
 */

const { omar, nadia, rafi, priya, lena } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});

test('ten concurrent opens of one pair, from both sides, give one channel and exactly one creation', async ({ request }) => {
  const opens = await Promise.all(
    Array.from({ length: 10 }, (_, i) => {
      const [me, other] = i % 2 === 0 ? [nadia, rafi] : [rafi, nadia];
      return request.post('/api/dms', { headers: as(me), data: { personIds: [other.personId] } });
    }),
  );
  for (const res of opens) expect(res.status(), await res.text()).toBeLessThan(300);
  const parsed = await Promise.all(opens.map(async (res) => OpenDmResponse.parse(await res.json())));
  expect(new Set(parsed.map((p) => p.dm.channel.id)).size).toBe(1);
  expect(parsed.filter((p) => p.created).length).toBeLessThanOrEqual(1);   // 1 on a fresh server, 0 if an earlier run made it
  expect(parsed[0]?.dm.channel.dmKey).toBe([nadia.personId, rafi.personId].sort().join(','));

  // Both people list it exactly once.
  for (const person of [nadia, rafi]) {
    const list = ListDmsResponse.parse(await (await request.get('/api/dms', { headers: as(person) })).json());
    expect(list.items.filter((i) => i.channel.id === parsed[0]?.dm.channel.id)).toHaveLength(1);
  }
});

test('a DM is private: not for the workspace admin, another member or a guest; a guest cannot open one', async ({ request }) => {
  const opened = OpenDmResponse.parse(await (await request.post('/api/dms', { headers: as(rafi), data: { personIds: [priya.personId] } })).json());
  const id = opened.dm.channel.id;
  const sent = await request.post(`/api/channels/${id}/messages`, { headers: as(priya), data: { channelId: id, body: 'between us', threadRootId: null } });
  expect(sent.status()).toBe(201);
  expect((await request.get(`/api/channels/${id}/messages`, { headers: as(rafi) })).status()).toBe(200);
  for (const outsider of [omar, nadia, lena]) {
    expect((await request.get(`/api/channels/${id}/messages`, { headers: as(outsider) })).status(), outsider.key).toBe(403);
  }
  const adminList = ListDmsResponse.parse(await (await request.get('/api/dms', { headers: as(omar) })).json());
  expect(adminList.items.some((i) => i.channel.id === id)).toBe(false);
  expect((await request.post('/api/dms', { headers: as(lena), data: { personIds: [nadia.personId] } })).status()).toBe(403);
  expect((await request.post('/api/dms', { headers: as(nadia), data: { personIds: [lena.personId] } })).status()).toBe(400);
  expect((await request.post('/api/dms', { data: { personIds: [nadia.personId] } })).status()).toBe(401);
});
