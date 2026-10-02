import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { personas, type Persona } from '@manythreads/test-utils';

/**
 * Row level security of channels and messages through the HTTP API (PLAN criteria 3, 8 and 10; spec
 * e2e/api/messages/rls.spec.ts): Sameera (Customer support) reaches nothing of Engineering, a private channel is invisible to
 * everybody who is not in it (Priya, a member of Engineering, included), and Lena the guest sees one channel after a grant,
 * read-only. Every refusal is a 403, whether the channel is hidden or does not exist. Callers use the test-only dev header.
 */

const { omar, nadia, rafi, sameera, priya, lena } = personas;

const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});

async function makeChannel(request: APIRequestContext, name: string, isPrivate = false): Promise<string> {
  const res = await request.post('/api/teams/engineering/channels', { headers: as(omar), data: { name, private: isPrivate } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { channel: { id: string } }).channel.id;
}
const slug = (): string => `c-${randomUUID().slice(0, 8)}`;
const post = (request: APIRequestContext, p: Persona, channelId: string, body = 'hello') =>
  request.post(`/api/channels/${channelId}/messages`, { headers: as(p), data: { channelId, body, threadRootId: null } });
const directoryNames = async (request: APIRequestContext, p: Persona, team = 'engineering'): Promise<string[]> => {
  const res = await request.get(`/api/teams/${team}/channels`, { headers: as(p) });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { groups: { channels: { name: string }[] }[] }).groups.flatMap((g) => g.channels.map((c) => c.name));
};

test.describe('Sameera cannot cross into Engineering', () => {
  test('she cannot read, post, react in or list members of an Engineering channel; the directory is empty', async ({ request }) => {
    const name = slug();
    const id = await makeChannel(request, name);
    const msg = await post(request, nadia, id, 'engineering only');
    expect(msg.status()).toBe(201);
    const messageId = ((await msg.json()) as { id: string }).id;
    expect((await request.get(`/api/channels/${id}`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.get(`/api/channels/${id}/messages`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.get(`/api/channels/${id}/messages/${messageId}`, { headers: as(sameera) })).status()).toBe(403);
    expect((await post(request, sameera, id)).status()).toBe(403);
    expect((await request.post(`/api/channels/${id}/messages/${messageId}/reactions`, { headers: as(sameera), data: { emoji: '👍' } })).status()).toBe(403);
    expect((await request.get(`/api/channels/${id}/members`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.post(`/api/channels/${id}/join`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.patch(`/api/channels/${id}/messages/${messageId}`, { headers: as(sameera), data: { body: 'x' } })).status()).toBe(403);
    expect((await request.delete(`/api/channels/${id}/messages/${messageId}`, { headers: as(sameera) })).status()).toBe(403);
    expect(await directoryNames(request, sameera)).toEqual([]);
    expect(await directoryNames(request, nadia)).toContain(name);
  });

  test('an unknown channel is 403 too, so nobody can probe for existence; no actor is 401', async ({ request }) => {
    expect((await request.get(`/api/channels/${randomUUID()}`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.get(`/api/channels/${randomUUID()}/messages`, { headers: as(nadia) })).status()).toBe(403);
    expect((await request.get(`/api/channels/${randomUUID()}`)).status()).toBe(401);
    expect((await request.post(`/api/channels/${randomUUID()}/messages`, { data: { channelId: randomUUID(), body: 'x', threadRootId: null } })).status()).toBe(401);
  });

  test('she cannot create channels in Engineering, nor change one', async ({ request }) => {
    const id = await makeChannel(request, slug());
    expect((await request.post('/api/teams/engineering/channels', { headers: as(sameera), data: { name: slug() } })).status()).toBe(403);
    expect((await request.patch(`/api/channels/${id}`, { headers: as(sameera), data: { purpose: 'mine' } })).status()).toBe(403);
    expect((await request.post(`/api/channels/${id}/archive`, { headers: as(sameera) })).status()).toBe(403);
    expect((await request.post(`/api/channels/${id}/members`, { headers: as(sameera), data: { personId: sameera.personId } })).status()).toBe(403);
  });
});

test.describe('a private channel is invisible to everybody who is not in it', () => {
  test('Priya (Engineering) and Nadia cannot see it, read it, post in it or find it in the sidebar; its member can', async ({ request }) => {
    const name = slug();
    const id = await makeChannel(request, name, true);
    expect((await request.post(`/api/channels/${id}/members`, { headers: as(omar), data: { personId: rafi.personId } })).status()).toBe(200);
    expect((await post(request, rafi, id, 'only us')).status()).toBe(201);
    for (const who of [priya, nadia, sameera, lena]) {
      expect((await request.get(`/api/channels/${id}`, { headers: as(who) })).status(), who.key).toBe(403);
      expect((await request.get(`/api/channels/${id}/messages`, { headers: as(who) })).status(), who.key).toBe(403);
      expect((await post(request, who, id)).status(), who.key).toBe(403);
      expect((await request.post(`/api/channels/${id}/join`, { headers: as(who) })).status(), who.key).toBe(403);
    }
    expect(await directoryNames(request, priya)).not.toContain(name);
    expect(await directoryNames(request, rafi)).toContain(name);
    const list = await request.get(`/api/channels/${id}/messages`, { headers: as(rafi) });
    expect(((await list.json()) as { items: { body: string }[] }).items.map((m) => m.body)).toEqual(['only us']);
  });
});

test.describe('Lena, a guest, sees exactly the channel she was granted', () => {
  test('nothing before the grant; after a read grant she reads that channel only and cannot post; a post grant lets her', async ({ request }) => {
    // Private channels of Omar's (a grant reaches private channels too, and nobody else on the shared api server gets unread counts from them).
    const releases = await makeChannel(request, slug(), true);
    const other = await makeChannel(request, slug(), true);
    await post(request, omar, releases, 'v2 shipped');
    await post(request, omar, other, 'not for guests');
    expect((await request.get(`/api/channels/${releases}/messages`, { headers: as(lena) })).status()).toBe(403);
    expect(await directoryNames(request, lena)).toEqual([]);

    const grant = (permission: 'read' | 'post') =>
      request.post('/api/test/channel-grants', { headers: as(omar), data: { channelId: releases, personId: lena.personId, permission } });
    expect((await request.post('/api/test/channel-grants', { headers: as(nadia), data: { channelId: releases, personId: lena.personId, permission: 'read' } })).status()).toBe(403);
    expect((await grant('read')).status()).toBe(200);
    const list = await request.get(`/api/channels/${releases}/messages`, { headers: as(lena) });
    expect(list.status()).toBe(200);
    expect(((await list.json()) as { items: { body: string }[] }).items.map((m) => m.body)).toEqual(['v2 shipped']);
    expect((await request.get(`/api/channels/${other}/messages`, { headers: as(lena) })).status()).toBe(403);
    expect((await request.get(`/api/channels/${other}`, { headers: as(lena) })).status()).toBe(403);
    expect((await request.get(`/api/channels/${releases}/members`, { headers: as(lena) })).status()).toBe(403);
    expect((await post(request, lena, releases, 'hi')).status()).toBe(403);
    const detail = await request.get(`/api/channels/${releases}`, { headers: as(lena) });
    expect(((await detail.json()) as { canPost: boolean }).canPost).toBe(false);
    expect(await directoryNames(request, lena)).toHaveLength(1);
    expect(await directoryNames(request, lena, 'whatever-slug')).toHaveLength(1);

    expect((await grant('post')).status()).toBe(200);
    expect((await post(request, lena, releases, 'Thanks')).status()).toBe(201);
    expect((await post(request, lena, other, 'sneak')).status()).toBe(403);
  });
});
