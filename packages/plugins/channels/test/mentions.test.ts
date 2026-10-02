import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, sameera, priya, lena } = personas;

let w: World;
let dev = '';
let general = '';
let releases = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  general = await w.channelId('engineering', 'general');
  releases = await w.channelId('engineering', 'releases');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const post = async (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> => {
  const res: ApiResult<{ id: string }> = await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
};
const edit = async (who: Persona, channelId: string, id: string, body: string): Promise<void> => {
  const res = await w.call(who, 'PATCH', `/api/channels/${channelId}/messages/${id}`, { body });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};
type Mention = { mentioned_id: string; kind: string };
const mentions = (messageId: string): Promise<Mention[]> =>
  w.system(async (tx) => (await tx.query<Mention>('SELECT mentioned_id, kind FROM app.message_mentions WHERE message_id = $1 ORDER BY kind, mentioned_id', [messageId])).rows);
const person = (p: Persona): Mention => ({ mentioned_id: p.actorId, kind: 'person' });
const byId = (...m: Mention[]): Mention[] => [...m].sort((a, b) => (a.kind === b.kind ? (a.mentioned_id < b.mentioned_id ? -1 : 1) : a.kind < b.kind ? -1 : 1));
const events = (messageId: string): Promise<Array<{ mentionedId: string; personId: string; authorId: string; kind: string; teamId: string | null; threadRootId: string | null; actor_id: string }>> =>
  w.system(async (tx) => (await tx.query(
    `SELECT payload->>'mentionedId' AS "mentionedId", payload->>'personId' AS "personId", payload->>'authorId' AS "authorId", payload->>'kind' AS kind,
            payload->>'teamId' AS "teamId", payload->>'threadRootId' AS "threadRootId", actor_id
       FROM app.events WHERE type = 'channel.mention.created' AND payload->>'messageId' = $1 ORDER BY id`, [messageId])).rows as never);
const links = async (who: Persona, messageId: string): Promise<Array<{ direction: string; other: { type: string; id: string } }>> =>
  ((await w.call<{ links: Array<{ direction: string; other: { type: string; id: string } }> }>(who, 'GET', `/api/links?type=message&id=${messageId}&direction=out`)).body.links);

describe('mentions: @person and #channel are parsed on post and stored (P3-07)', () => {
  it('stores a person mention per resolved handle, a channel mention per #name, and ignores the author, strangers and unknown handles', async () => {
    const id = await post(nadia, dev, 'Hi @rafi and @Priya.Anything, ask @nobody-here and @nadia about #general and #no-such-channel');
    // @priya.anything is an email local part nobody has and not a name: unknown. @nadia is the author. Only @rafi and #general count.
    expect(await mentions(id)).toEqual(byId(person(rafi), { mentioned_id: general, kind: 'channel' }));
    const ev = await events(id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ mentionedId: rafi.actorId, personId: rafi.personId, authorId: nadia.actorId, kind: 'person', actor_id: nadia.actorId });
    expect(ev[0]?.teamId).not.toBeNull();
    expect(ev[0]?.threadRootId).toBeNull();
  });

  it('resolves a first name, an email local part and a name slug; a reply records its thread', async () => {
    const root = await post(rafi, dev, 'plain root');
    const id = await post(nadia, dev, '@priya @rafi@kahf.example @omar', root);
    // "@rafi@kahf.example" is an e-mail address, not a mention.
    expect(await mentions(id)).toEqual(byId(person(priya), person(omar)));
    expect((await events(id)).map((e) => e.mentionedId).sort()).toEqual([omar.actorId, priya.actorId].sort());
    expect((await events(id))[0]?.threadRootId).toBe(root);
  });

  it('ignores mentions inside code spans, code fences, links and URLs, and escaped ones', async () => {
    const body = [
      'inline `@rafi` and `#general`',
      '```',
      '@priya in a fence #general',
      '```',
      '[a link](https://x.example/@omar#general) https://x.example/@rafi #12',
      'escaped \\@priya and mail priya@kahf.example',
    ].join('\n');
    const id = await post(nadia, dev, body);
    expect(await mentions(id)).toEqual([]);
    expect(await events(id)).toEqual([]);
  });

  it('does not name a person who cannot read the channel (no row, no event, nothing learned)', async () => {
    const id = await post(nadia, dev, '@sameera are you there? @lena and @rafi');
    expect(await mentions(id)).toEqual([person(rafi)]);
    // In a private channel only its members count.
    const priv = (await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'mention-private', private: true })).body.channel.id;
    const m = await post(omar, priv, '@rafi @nadia @omar');
    expect(await mentions(m)).toEqual([]);
    expect((await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: rafi.personId })).status).toBe(200);
    expect(await mentions(await post(omar, priv, '@rafi @nadia'))).toEqual([person(rafi)]);
  });

  it('an edit adds, removes and keeps mentions; only people newly named are announced', async () => {
    const id = await post(nadia, dev, 'first @rafi and #general');
    expect((await events(id)).map((e) => e.mentionedId)).toEqual([rafi.actorId]);
    await edit(nadia, dev, id, 'now @rafi and @priya');
    expect(await mentions(id)).toEqual(byId(person(rafi), person(priya)));
    expect((await events(id)).map((e) => e.mentionedId)).toEqual([rafi.actorId, priya.actorId]);   // rafi was not announced again
    await edit(nadia, dev, id, 'now @priya only, in #releases');
    expect(await mentions(id)).toEqual(byId(person(priya), { mentioned_id: releases, kind: 'channel' }));
    expect(await events(id)).toHaveLength(2);
    await edit(nadia, dev, id, 'no mentions at all');
    expect(await mentions(id)).toEqual([]);
    expect((await w.call(nadia, 'GET', `/api/channels/${dev}/messages/${id}`)).status).toBe(200);
  });

  it('a message in a direct message names people too, with no team on the event', async () => {
    const dm = (await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [rafi.personId, priya.personId] })).body.dm.channel.id;
    const id = await post(nadia, dm, '@rafi @priya @sameera #general');
    expect(await mentions(id)).toEqual(byId(person(rafi), person(priya)));       // #general is no channel of a DM; Sameera is not in it
    expect((await events(id))[0]?.teamId).toBeNull();
  });

  it('a mention does not stop a rolled-back post: a refused post leaves no mention and no event', async () => {
    const before = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'channel.mention.created'")).rows[0]!.n);
    const refused = await w.call(lena, 'POST', `/api/channels/${releases}/messages`, { channelId: releases, body: '@rafi', threadRootId: null });
    expect(refused.status).toBe(403);
    const after = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'channel.mention.created'")).rows[0]!.n);
    expect(after).toBe(before);
  });
});

describe('entity references: [[thread:id]] becomes a link from the message', () => {
  it('links to a thread the author can see, and drops the link when an edit drops the reference', async () => {
    const root = await post(rafi, dev, 'The deploy thread');
    await post(nadia, dev, 'reply', root);
    const id = await post(nadia, general, `see [[thread:${root}]] and [[thread:${randomUUID()}]] and [[page:docs/runbook.md]] and [[task:not-a-uuid]]`);
    const found = await links(nadia, id);
    expect(found.map((l) => [l.direction, l.other.type, l.other.id])).toEqual([['out', 'thread', root]]);
    // The incoming side: the thread knows which messages point at it.
    const incoming = (await w.call<{ links: Array<{ direction: string; other: { type: string; id: string } }> }>(rafi, 'GET', `/api/links?type=thread&id=${root}&direction=in`)).body.links;
    expect(incoming.map((l) => l.other.id)).toEqual([id]);
    await edit(nadia, general, id, 'the link is gone');
    expect(await links(nadia, id)).toEqual([]);
    await edit(nadia, general, id, `back: [[thread:${root}]]`);
    expect((await links(nadia, id)).length).toBe(1);
  });

  it('does not link a thread the author cannot read, nor from a channel of a team the author is not on', async () => {
    const priv = (await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'link-private', private: true })).body.channel.id;
    const secret = await post(omar, priv, 'secret');
    await post(omar, priv, 'secret reply', secret);
    const id = await post(nadia, dev, `[[thread:${secret}]]`);
    expect(await links(nadia, id)).toEqual([]);
    expect(await links(omar, id)).toEqual([]);
    // The ordinary post still succeeded and carries the text; the guest of #releases cannot post at all.
    expect((await w.call(sameera, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: `[[thread:${secret}]]`, threadRootId: null })).status).toBe(403);
  });
});
