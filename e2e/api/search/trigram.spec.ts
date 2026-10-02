import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { personas, type Persona } from '@manythreads/test-utils';

/**
 * Search through the HTTP API (PLAN criterion 6, spec e2e/search/basic.spec.ts and trigram.spec.ts, API part): a typo finds the word,
 * what a person cannot read is never found (a private channel, another team, a guest outside the grant), results are grouped by kind.
 */

const { omar, nadia, rafi, sameera, priya, lena } = personas;
const as = (p: Persona): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }),
});
const slug = (): string => `srch-${randomUUID().slice(0, 8)}`;
// A word nobody else uses in this database, so a run is independent of every other spec.
const unique = (): string => `zq${randomUUID().replace(/-/g, '').slice(0, 9)}`;

async function makeChannel(request: APIRequestContext, isPrivate = false): Promise<string> {
  const res = await request.post('/api/teams/engineering/channels', { headers: as(omar), data: { name: slug(), private: isPrivate } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { channel: { id: string } }).channel.id;
}
const post = async (request: APIRequestContext, p: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> => {
  const res = await request.post(`/api/channels/${channelId}/messages`, { headers: as(p), data: { channelId, body, threadRootId } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
interface Hits {
  messages: { id: string; channel: { id: string }; snippet: string; score: number }[];
  threads: { rootMessageId: string; title: string }[];
  files: { id: string; name: string }[];
}
const search = async (request: APIRequestContext, p: Persona, q: string, extra: Record<string, string> = {}): Promise<Hits> => {
  const res = await request.get('/api/search', { headers: as(p), params: { q, ...extra } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Hits;
};

test('"rolback" finds "rollback", and what is not readable is never found', async ({ request }) => {
  const word = unique();
  const pub = await makeChannel(request);
  const priv = await makeChannel(request, true);
  expect((await request.post(`/api/channels/${priv}/members`, { headers: as(omar), data: { personId: rafi.personId } })).status()).toBe(200);
  // Omar created the channel and so is its first member: he leaves, to be what the test says, an admin who is not in it.
  expect((await request.delete(`/api/channels/${priv}/members/${omar.personId}`, { headers: as(omar) })).status()).toBe(200);
  const open = await post(request, nadia, pub, `we must rollback the ${word} deploy tonight`);
  const secret = await post(request, rafi, priv, `private rollback plan for ${word}`);

  // Criterion 6: the typo finds the word (as a member of the team), and the exact word does too.
  const typo = await search(request, nadia, 'rolback', { scope: 'messages' });
  expect(typo.messages.map((m) => m.id)).toContain(open);
  expect((await search(request, nadia, word)).messages.map((m) => m.id)).toEqual([open]);
  expect((await search(request, nadia, word.slice(0, 6) + word.slice(7))).messages.map((m) => m.id)).toEqual([open]); // a letter missing

  // Nadia (Engineering, not in the private channel), Priya, Sameera (another team) and Lena (guest, no grant) never see the private text.
  for (const who of [nadia, priya, sameera, lena]) {
    const hits = await search(request, who, word);
    expect(hits.messages.map((m) => m.id), who.key).not.toContain(secret);
    expect(JSON.stringify(hits), who.key).not.toContain('private rollback plan');
  }
  // Sameera finds nothing of Engineering at all; Rafi, a member, finds both; Omar (workspace admin) is not a member either.
  expect((await search(request, sameera, word)).messages).toEqual([]);
  expect((await search(request, rafi, word)).messages.map((m) => m.id).sort()).toEqual([open, secret].sort());
  expect((await search(request, omar, word)).messages.map((m) => m.id)).toEqual([open]);
});

test('Lena (a guest with no grant) finds nothing', async ({ request }) => {
  // The grant case lives in the vitest suite (packages/plugins/search/test): this server is shared by every api spec, so no spec here
  // changes what a persona can see.
  const word = unique();
  const channelId = await makeChannel(request);
  await post(request, nadia, channelId, `${word} release notes`);
  expect(await search(request, lena, word)).toMatchObject({ messages: [], threads: [], files: [] });
});

test('results are grouped: messages, thread titles and file names; best match first, then newest', async ({ request }) => {
  const word = unique();
  const channelId = await makeChannel(request);
  const root = await post(request, nadia, channelId, `${word} deploy plan`);
  // The root's author replies to it: nobody else follows the thread, so nobody's shared unread counts change (the api specs share one server).
  await post(request, nadia, channelId, 'looks good', root);
  const older = await post(request, nadia, channelId, `${word.slice(0, 5)}${word.slice(6)} typo version`);
  const newer = await post(request, nadia, channelId, `${word} newest exact`);
  const file = await request.post(`/api/channels/${channelId}/files`, {
    headers: { ...as(nadia), 'content-type': 'application/pdf', 'x-file-name': `${word}-agenda.pdf` },
    data: Buffer.from('%PDF-1.4\n'),
  });
  expect(file.status()).toBe(201);

  const all = await search(request, rafi, word);
  expect(all.threads.map((t) => t.rootMessageId)).toEqual([root]);
  expect(all.files.map((f) => f.name)).toEqual([`${word}-agenda.pdf`]);
  // Exact spelling outranks the typo; among exact matches the newest comes first.
  const order = all.messages.map((m) => m.id);
  expect(order.indexOf(newer)).toBeLessThan(order.indexOf(root));
  expect(order.indexOf(root)).toBeLessThan(order.indexOf(older));

  expect((await search(request, rafi, word, { scope: 'files' })).messages).toEqual([]);
  expect((await search(request, rafi, word, { scope: 'files' })).files).toHaveLength(1);
  expect((await search(request, rafi, word, { scope: 'threads' })).threads).toHaveLength(1);
  // Sameera sees none of it, the file name included.
  const none = await search(request, sameera, word);
  expect(none).toMatchObject({ messages: [], threads: [], files: [] });
});

test('an edit is searchable at once, a deleted message is gone, bad queries are 400, no actor is 401', async ({ request }) => {
  const word = unique();
  const channelId = await makeChannel(request);
  const id = await post(request, nadia, channelId, 'before the edit');
  expect((await search(request, rafi, word)).messages).toEqual([]);
  expect((await request.patch(`/api/channels/${channelId}/messages/${id}`, { headers: as(nadia), data: { body: `after the edit ${word}` } })).status()).toBe(200);
  expect((await search(request, rafi, word)).messages.map((m) => m.id)).toEqual([id]);
  expect((await request.delete(`/api/channels/${channelId}/messages/${id}`, { headers: as(nadia) })).status()).toBe(200);
  expect((await search(request, rafi, word)).messages).toEqual([]);

  expect((await request.get('/api/search', { headers: as(rafi), params: { q: 'a' } })).status()).toBe(400);
  expect((await request.get('/api/search', { headers: as(rafi) })).status()).toBe(400);
  expect((await request.get('/api/search', { headers: as(rafi), params: { q: 'rollback', scope: 'everything' } })).status()).toBe(400);
  expect((await request.get('/api/search', { params: { q: 'rollback' } })).status()).toBe(401);
});
