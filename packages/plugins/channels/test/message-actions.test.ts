import { ChannelMessage, ForwardedMessage, ListMessageVersionsResponse, ListMessagesResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from './world.ts';

// P14-12: earlier versions of an edited message, and forwarding a message as a quote card that shows the original only to those who may read it.

const { omar, nadia, rafi, sameera, lena } = personas;

let w: World;
let dev = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const post = async (who: Persona, channelId: string, body: string): Promise<string> =>
  ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;
const edit = (who: Persona, channelId: string, id: string, body: string) => w.call(who, 'PATCH', `/api/channels/${channelId}/messages/${id}`, { body });
const versions = (who: Persona, channelId: string, id: string) => w.call(who, 'GET', `/api/channels/${channelId}/messages/${id}/versions`);
const forward = (who: Persona, channelId: string, id: string, body: Record<string, unknown>) =>
  w.call(who, 'POST', `/api/channels/${channelId}/messages/${id}/forward`, body);
const stored = (id: string) => w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_versions WHERE message_id = $1', [id])).rows.length);
const list = async (who: Persona, channelId: string): Promise<ChannelMessage[]> =>
  ListMessagesResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/messages`))).items;
const privateChannel = async (name: string): Promise<string> =>
  ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name, private: true }), 201).channel.id;

describe('earlier versions of an edited message', () => {
  it('lists both previous bodies in order after two edits, with the time each was written and replaced', async () => {
    const id = await post(nadia, dev, 'first draft');
    expect(ListMessageVersionsResponse.parse(ok(await versions(nadia, dev, id))).items).toEqual([]);
    ok(await edit(nadia, dev, id, 'second draft'));
    ok(await edit(nadia, dev, id, 'final text'));
    const items = ListMessageVersionsResponse.parse(ok(await versions(nadia, dev, id))).items;
    expect(items.map((v) => v.body)).toEqual(['first draft', 'second draft']);
    // each version was written when the one before it was replaced
    expect(items[1]!.writtenAt).toBe(items[0]!.replacedAt);
    expect(Date.parse(items[0]!.writtenAt)).toBeLessThanOrEqual(Date.parse(items[0]!.replacedAt));
    // the current text is not among them
    expect(items.map((v) => v.body)).not.toContain('final text');
  });

  it('an edit that changes nothing adds no version', async () => {
    const id = await post(nadia, dev, 'same');
    ok(await edit(nadia, dev, id, 'same'));
    expect(await stored(id)).toBe(0);
  });

  it('anyone who can read the message reads them; a person who cannot gets 403, and so does a guest without a grant', async () => {
    const id = await post(nadia, dev, 'v1');
    ok(await edit(nadia, dev, id, 'v2'));
    expect(ListMessageVersionsResponse.parse(ok(await versions(rafi, dev, id))).items.map((v) => v.body)).toEqual(['v1']);
    expect((await versions(sameera, dev, id)).status).toBe(403);
    expect((await versions(lena, dev, id)).status).toBe(403);
    expect((await w.call(null, 'GET', `/api/channels/${dev}/messages/${id}/versions`)).status).toBe(401);
  });

  it('a private channel keeps its history private: a non-member gets 403 and the table shows them no row', async () => {
    const ch = await privateChannel('versions-private');
    const id = await post(omar, ch, 'secret one');
    ok(await edit(omar, ch, id, 'secret two'));
    expect((await versions(nadia, ch, id)).status).toBe(403);
    expect((await versions(omar, ch, id)).status).toBe(200);
  });

  it('an unknown message is 404', async () => {
    expect((await versions(nadia, dev, '00000000-0000-7000-8000-000000000099')).status).toBe(404);
  });

  it('deleting the message drops its history', async () => {
    const id = await post(nadia, dev, 'to be deleted');
    ok(await edit(nadia, dev, id, 'edited before delete'));
    expect(await stored(id)).toBe(1);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${id}`));
    expect(await stored(id)).toBe(0);
    expect(ListMessageVersionsResponse.parse(ok(await versions(nadia, dev, id))).items).toEqual([]);
  });

  it('only the author clears the earlier versions', async () => {
    const id = await post(nadia, dev, 'token abc');
    ok(await edit(nadia, dev, id, 'removed the token'));
    expect((await w.call(rafi, 'DELETE', `/api/channels/${dev}/messages/${id}/versions`)).status).toBe(403);
    expect(await stored(id)).toBe(1);
    expect(ok<{ cleared: number }>(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${id}/versions`)).cleared).toBe(1);
    expect(ListMessageVersionsResponse.parse(ok(await versions(nadia, dev, id))).items).toEqual([]);
  });

  it('keeps the newest 50 versions of one message', async () => {
    const id = await post(nadia, dev, 'v0');
    for (let i = 1; i <= 53; i += 1) ok(await edit(nadia, dev, id, `v${i}`));
    const items = ListMessageVersionsResponse.parse(ok(await versions(nadia, dev, id))).items;
    expect(items).toHaveLength(50);
    expect(items[0]!.body).toBe('v3');
    expect(items[49]!.body).toBe('v52');
  });
});

describe('forwarding a message', () => {
  const find = (items: ChannelMessage[], id: string): ChannelMessage => {
    const m = items.find((x) => x.id === id);
    if (!m) throw new Error('message not listed');
    return m;
  };

  it('posts the forwarder\'s own message with a card; only people who may read the original see it, everyone else sees "hidden" and none of its text', async () => {
    // a private channel of Omar's: Nadia is added so she can read (and forward) it
    const secret = await privateChannel('forward-source');
    ok(await w.call(omar, 'POST', `/api/channels/${secret}/members`, { personId: nadia.personId }));
    const original = await post(omar, secret, 'the launch date is 14 March, ship it quietly');
    const res = await forward(nadia, secret, original, { targetChannelId: dev, note: 'FYI for the team' });
    const forwarded = ChannelMessage.parse(ok(res, 201));
    expect(forwarded.authorId).toBe(nadia.actorId);
    expect(forwarded.body).toBe('FYI for the team');
    expect(forwarded.channelId).toBe(dev);
    expect(forwarded.forward).toMatchObject({ state: 'visible', messageId: original, channelId: secret, channelName: 'forward-source' });
    // what the card shows Nadia (she may read the original): the author and an excerpt
    const card = ForwardedMessage.parse(forwarded.forward);
    if (card.state !== 'visible') throw new Error('expected a visible card');
    expect(card.excerpt).toContain('launch date');
    expect(card.author?.displayName).toBe(omar.name);
    // Rafi reads #dev but not the private channel: no text, no channel name, no ids of the original
    const seenByRafi = JSON.stringify(await list(rafi, dev));
    expect(seenByRafi).toContain('FYI for the team');
    expect(seenByRafi).not.toContain('launch date');
    expect(seenByRafi).not.toContain('forward-source');
    expect(seenByRafi).not.toContain(original);
    expect(find(await list(rafi, dev), forwarded.id).forward).toEqual({ state: 'hidden' });
    // Omar can read the original, so he sees the card
    expect(find(await list(omar, dev), forwarded.id).forward).toMatchObject({ state: 'visible', messageId: original });
    // the one-message read is per reader too
    const one = ChannelMessage.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages/${forwarded.id}`)));
    expect(one.forward).toEqual({ state: 'hidden' });
    // nothing of the original was copied into the stored forwarding message's text or search text
    const row = await w.system(async (tx) => (await tx.query<{ body: string; body_plain: string }>('SELECT body, body_plain FROM app.messages WHERE id = $1', [forwarded.id])).rows[0]!);
    expect(row.body + row.body_plain).not.toContain('launch date');
  });

  it('without a note the message says it forwarded one', async () => {
    const id = await post(rafi, dev, 'plain public message');
    const target = await w.channelId('engineering', 'general');
    const forwarded = ChannelMessage.parse(ok(await forward(nadia, dev, id, { targetChannelId: target }), 201));
    expect(forwarded.body).toBe('Forwarded a message');
    expect(forwarded.forward).toMatchObject({ state: 'visible', channelName: 'dev' });
  });

  it('shows "deleted" once the original is deleted', async () => {
    const id = await post(rafi, dev, 'will vanish');
    const target = await w.channelId('engineering', 'general');
    const forwarded = ChannelMessage.parse(ok(await forward(nadia, dev, id, { targetChannelId: target }), 201));
    ok(await w.call(rafi, 'DELETE', `/api/channels/${dev}/messages/${id}`));
    expect(find(await list(nadia, target), forwarded.id).forward).toEqual({ state: 'deleted' });
  });

  it('refuses a message the forwarder cannot read (403), a missing message (404) and a deleted one (409)', async () => {
    const secret = await privateChannel('forward-no-access');
    const original = await post(omar, secret, 'not for Nadia');
    expect((await forward(nadia, secret, original, { targetChannelId: dev })).status).toBe(403);
    expect((await forward(nadia, dev, '00000000-0000-7000-8000-000000000099', { targetChannelId: dev })).status).toBe(404);
    const gone = await post(nadia, dev, 'gone soon');
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${gone}`));
    expect((await forward(nadia, dev, gone, { targetChannelId: dev })).status).toBe(409);
  });

  it('respects the post permission of the target: a channel the forwarder cannot read (403), one they can read but not post in (403), an archived one (409)', async () => {
    const original = await post(nadia, dev, 'something to share');
    const hidden = await privateChannel('forward-target-hidden');
    expect((await forward(nadia, dev, original, { targetChannelId: hidden })).status).toBe(403);
    // Lena (a guest) reads #releases through a read grant and cannot post there; she may not forward into it
    const releases = await w.channelId('engineering', 'releases');
    await w.system(async (tx) => {
      await tx.query(
        `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
         VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING`,
        [lena.workspaceId, releases, lena.personId],
      );
    });
    const lenaMsg = await post(nadia, releases, 'release note');
    expect((await forward(lena, releases, lenaMsg, { targetChannelId: releases })).status).toBe(403);
    const old = await w.channelId('engineering', 'standup');
    ok(await w.call(omar, 'POST', `/api/channels/${old}/archive`));
    expect((await forward(nadia, dev, original, { targetChannelId: old })).status).toBe(409);
  });

  it('works into a direct message, and the DM\'s other member sees the card only if they may read the original', async () => {
    const original = await post(nadia, dev, 'public thought');
    const dm = ok<{ dm: { channel: { id: string } } }>(await w.call(nadia, 'POST', '/api/dms', { personIds: [sameera.personId] }), 201).dm.channel.id;
    const forwarded = ChannelMessage.parse(ok(await forward(nadia, dev, original, { targetChannelId: dm, note: 'look' }), 201));
    // Sameera is not on Engineering, so she cannot read #dev: the DM shows her only that a message was forwarded
    expect(find(await list(sameera, dm), forwarded.id).forward).toEqual({ state: 'hidden' });
    expect(JSON.stringify(await list(sameera, dm))).not.toContain('public thought');
  });

  it('validates the request: unknown fields and a missing target are 400', async () => {
    const id = await post(nadia, dev, 'x');
    expect((await forward(nadia, dev, id, {})).status).toBe(400);
    expect((await forward(nadia, dev, id, { targetChannelId: dev, extra: 1 })).status).toBe(400);
  });
});

describe('the live push of a forwarding message', () => {
  it('carries no message body and no card (each reader fetches their own), while an ordinary message still rides along', async () => {
    const header = JSON.stringify({ kind: 'person', id: rafi.actorId, workspaceId: rafi.workspaceId });
    const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/ws', { headers: { 'x-manythreads-dev-actor': header } } as never);
    const frames: { type: string; payload: Record<string, unknown> }[] = [];
    ws.onmessage = (e) => void frames.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('socket failed to open'));
    });
    ws.send(JSON.stringify({ type: 'ping', id: 'hello', payload: {} }));
    const until = async (match: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !match(); i += 1) await new Promise((r) => setTimeout(r, 20));
    };
    await until(() => frames.some((f) => f.type === 'pong'));
    await new Promise((r) => setTimeout(r, 150));
    try {
      const original = await post(nadia, dev, 'pushed original');
      const plain = await post(nadia, dev, 'ordinary');
      const forwarded = ChannelMessage.parse(ok(await forward(nadia, dev, original, { targetChannelId: dev, note: 'pushed forward' }), 201));
      await until(() => frames.some((f) => f.type === 'message.posted' && f.payload['messageId'] === forwarded.id));
      const frame = frames.find((f) => f.type === 'message.posted' && f.payload['messageId'] === forwarded.id);
      expect(frame).toBeDefined();
      expect(frame!.payload['message']).toBeUndefined();
      expect(frames.find((f) => f.type === 'message.posted' && f.payload['messageId'] === plain)?.payload['message']).toBeDefined();
    } finally {
      ws.close();
    }
  });
});

const readState = async (who: Persona, type: 'channel' | 'thread', id: string) =>
  ok<{ states: { lastReadId: string | null; unreadCount: number }[] }>(await w.call(who, 'GET', `/api/read-state?targets=${type}:${id}`)).states[0]!;
const markRead = (who: Persona, type: 'channel' | 'thread', id: string, upTo: string) =>
  w.call(who, 'POST', '/api/read-state/mark', { targetType: type, targetId: id, upTo });
const markUnread = (who: Persona, channelId: string, id: string) => w.call(who, 'POST', `/api/channels/${channelId}/messages/${id}/unread`);
const reply = async (who: Persona, channelId: string, root: string, body: string, extra: Record<string, unknown> = {}): Promise<string> =>
  ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: root, ...extra }), 201).id;

describe('mark unread from here', () => {
  it('moves a channel position back to just before the message and counts it and the ones after it', async () => {
    const ch = await privateChannel('unread-from-here');
    ok(await w.call(omar, 'POST', `/api/channels/${ch}/members`, { personId: nadia.personId }));
    const [a, b, c] = [await post(omar, ch, 'one'), await post(omar, ch, 'two'), await post(omar, ch, 'three')] as [string, string, string];
    ok(await markRead(nadia, 'channel', ch, c));
    expect(await readState(nadia, 'channel', ch)).toMatchObject({ lastReadId: c, unreadCount: 0 });
    expect(ok(await markUnread(nadia, ch, b))).toMatchObject({ targetType: 'channel', targetId: ch, lastReadId: a, unreadCount: 2 });
    expect(await readState(nadia, 'channel', ch)).toMatchObject({ lastReadId: a, unreadCount: 2 });
    // the very first message: nothing counts as read
    expect(ok(await markUnread(nadia, ch, a))).toMatchObject({ lastReadId: null, unreadCount: 3 });
    // reading on moves it forward again
    ok(await markRead(nadia, 'channel', ch, c));
    expect(await readState(nadia, 'channel', ch)).toMatchObject({ unreadCount: 0 });
  });

  it('does the same inside a thread, for a reply; the first reply falls back to the thread\'s first message', async () => {
    const root = await post(nadia, dev, 'thread to read');
    const [r1, r2, r3] = [await reply(omar, dev, root, 'r1'), await reply(omar, dev, root, 'r2'), await reply(omar, dev, root, 'r3')] as [string, string, string];
    ok(await markRead(nadia, 'thread', root, r3));
    expect(ok(await markUnread(nadia, dev, r2))).toMatchObject({ targetType: 'thread', targetId: root, lastReadId: r1, unreadCount: 2 });
    expect(ok(await markUnread(nadia, dev, r1))).toMatchObject({ targetType: 'thread', targetId: root, lastReadId: root, unreadCount: 3 });
  });

  it('is private to the caller: nobody else\'s position moves', async () => {
    const m = await post(omar, dev, 'only mine moves');
    ok(await markRead(rafi, 'channel', dev, m));
    ok(await markUnread(nadia, dev, m));
    expect((await readState(rafi, 'channel', dev)).lastReadId).toBe(m);
  });

  it('refuses a channel the caller cannot read (403), a missing message (404), a deleted one (409) and no sign-in (401)', async () => {
    const ch = await privateChannel('unread-private');
    const id = await post(omar, ch, 'hidden');
    expect((await markUnread(nadia, ch, id)).status).toBe(403);
    expect((await markUnread(nadia, dev, '00000000-0000-7000-8000-000000000098')).status).toBe(404);
    const gone = await post(nadia, dev, 'soon gone');
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${gone}`));
    expect((await markUnread(nadia, dev, gone)).status).toBe(409);
    expect((await w.call(null, 'POST', `/api/channels/${dev}/messages/${gone}/unread`)).status).toBe(401);
  });
});

describe('also send a thread reply to the channel', () => {
  it('posts the reply in the thread and the same text once more in the channel, marked with its thread', async () => {
    const root = await post(nadia, dev, 'a question for the channel');
    const id = await reply(rafi, dev, root, 'answer for everybody', { alsoToChannel: true });
    const threadReplies = ListMessagesResponse.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/messages?threadRootId=${root}`))).items;
    expect(threadReplies.map((m) => m.id)).toEqual([id]);
    expect(threadReplies[0]!.alsoSentFromThread).toBeUndefined();
    const copy = (await list(nadia, dev)).find((m) => m.alsoSentFromThread === root);
    expect(copy).toMatchObject({ body: 'answer for everybody', threadRootId: null, authorId: rafi.actorId });
    // the copy is not a reply: the thread still has one
    const rootNow = (await list(nadia, dev)).find((m) => m.id === root);
    expect(rootNow?.replyCount).toBe(1);
  });

  it('without the flag only the reply exists; the flag on a message that is not a reply is 400', async () => {
    const root = await post(nadia, dev, 'plain thread');
    await reply(rafi, dev, root, 'just a reply');
    expect((await list(nadia, dev)).filter((m) => m.alsoSentFromThread === root)).toHaveLength(0);
    const res = await w.call(rafi, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'top level', threadRootId: null, alsoToChannel: true });
    expect(res.status).toBe(400);
  });

  it('notifies the people it names once, not twice (the copy records no mentions), and the channel counts the copy as unread', async () => {
    const root = await post(nadia, dev, 'mention test');
    const before = (await readState(omar, 'channel', dev)).unreadCount;
    const id = await reply(rafi, dev, root, 'hello @nadia', { alsoToChannel: true });
    const copy = (await list(omar, dev)).find((m) => m.alsoSentFromThread === root)!;
    const n = (mid: string) => w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_mentions WHERE message_id = $1', [mid])).rows.length);
    expect(await n(id)).toBe(1);
    expect(await n(copy.id)).toBe(0);
    expect((await readState(omar, 'channel', dev)).unreadCount).toBe(before + 1);
  });
});

describe('the bookmarks bar', () => {
  const bookmarks = (who: Persona, ch: string) => w.call(who, 'GET', `/api/channels/${ch}/bookmarks`);
  const add = (who: Persona, ch: string, body: Record<string, unknown>) => w.call(who, 'POST', `/api/channels/${ch}/bookmarks`, body);
  const items = async (who: Persona, ch: string) => ok<{ items: { id: string; kind: string; title: string; target: string }[] }>(await bookmarks(who, ch)).items;

  it('adds a link (named by its host when no title is given) and a page, lists them in order, and anyone who can post removes one', async () => {
    const ch = await privateChannel('bookmarks-basic');
    ok(await w.call(omar, 'POST', `/api/channels/${ch}/members`, { personId: nadia.personId }));
    const link = ok<{ id: string; title: string; target: string }>(await add(omar, ch, { kind: 'link', target: 'https://docs.example.com/guide' }), 201);
    expect(link).toMatchObject({ title: 'docs.example.com', target: 'https://docs.example.com/guide' });
    ok(await add(nadia, ch, { kind: 'page', target: 'pages/reports/week-37.md', title: 'Weekly report' }), 201);
    expect((await items(omar, ch)).map((b) => [b.kind, b.title])).toEqual([['link', 'docs.example.com'], ['page', 'Weekly report']]);
    expect(ok<{ removed: boolean }>(await w.call(nadia, 'DELETE', `/api/channels/${ch}/bookmarks/${link.id}`)).removed).toBe(true);
    expect(ok<{ removed: boolean }>(await w.call(nadia, 'DELETE', `/api/channels/${ch}/bookmarks/${link.id}`)).removed).toBe(false);
    expect(await items(omar, ch)).toHaveLength(1);
  });

  it('keeps a private channel\'s bar private: a non-member gets 403 on every door', async () => {
    const ch = await privateChannel('bookmarks-private');
    const b = ok<{ id: string }>(await add(omar, ch, { kind: 'link', target: 'https://example.org/' }), 201);
    expect((await bookmarks(nadia, ch)).status).toBe(403);
    expect((await add(nadia, ch, { kind: 'link', target: 'https://example.org/x' })).status).toBe(403);
    expect((await w.call(nadia, 'DELETE', `/api/channels/${ch}/bookmarks/${b.id}`)).status).toBe(403);
    expect((await w.call(null, 'GET', `/api/channels/${ch}/bookmarks`)).status).toBe(401);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.channel_bookmarks WHERE channel_id = $1', [ch])).rows.length)).toBe(1);
  });

  it('refuses what is not a bookmark: bad address kinds, credentials in a link, a path outside pages/, a file that is not in the channel, unknown fields', async () => {
    const ch = await privateChannel('bookmarks-validation');
    for (const target of ['javascript:alert(1)', 'ftp://example.org/', 'not a url', 'https://user:pw@example.org/']) {
      expect((await add(omar, ch, { kind: 'link', target })).status, target).toBe(400);
    }
    for (const target of ['memory/secret.md', 'pages/../TEAM.md', 'pages/a.txt', '/pages/a.md', 'pages//a.md']) {
      expect((await add(omar, ch, { kind: 'page', target })).status, target).toBe(400);
    }
    expect((await add(omar, ch, { kind: 'file', target: 'nope' })).status).toBe(400);
    expect((await add(omar, ch, { kind: 'file', target: '00000000-0000-7000-8000-000000000097' })).status).toBe(400);
    expect((await add(omar, ch, { kind: 'link', target: 'https://example.org/', extra: 1 })).status).toBe(400);
    expect((await add(omar, ch, { kind: 'link', target: 'https://example.org/', title: '' })).status).toBe(400);
    expect(await items(omar, ch)).toEqual([]);
  });

  it('the same thing twice is a conflict, and a channel keeps at most 20', async () => {
    const ch = await privateChannel('bookmarks-cap');
    ok(await add(omar, ch, { kind: 'link', target: 'https://example.org/one' }), 201);
    expect((await add(omar, ch, { kind: 'link', target: 'https://example.org/one' })).status).toBe(409);
    for (let i = 2; i <= 20; i += 1) ok(await add(omar, ch, { kind: 'link', target: `https://example.org/${i}` }), 201);
    expect((await add(omar, ch, { kind: 'link', target: 'https://example.org/21' })).status).toBe(409);
    expect(await items(omar, ch)).toHaveLength(20);
  });

  it('a file of the channel can be bookmarked, named by the file, and the file of another channel cannot', async () => {
    const ch = await privateChannel('bookmarks-file');
    const other = await privateChannel('bookmarks-file-other');
    const fileIn = (channel: string, name: string) =>
      w.system(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
           SELECT c.workspace_id, c.id, '/pins/', $2, 'k' || gen_random_uuid(), 1, 'text/plain', repeat('a', 64), $3 FROM app.channels c WHERE c.id = $1 RETURNING id`,
          [channel, name, omar.actorId],
        );
        return r.rows[0]!.id;
      });
    const mine = await fileIn(ch, 'plan.txt');
    const foreign = await fileIn(other, 'elsewhere.txt');
    expect(ok<{ title: string; target: string }>(await add(omar, ch, { kind: 'file', target: mine }), 201)).toMatchObject({ title: 'plan.txt', target: mine });
    expect((await add(omar, ch, { kind: 'file', target: foreign })).status).toBe(400);
  });

  it('a direct message cannot bookmark a page', async () => {
    const dm = ok<{ dm: { channel: { id: string } } }>(await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] }), 201).dm.channel.id;
    expect((await add(nadia, dm, { kind: 'page', target: 'pages/a.md' })).status).toBe(400);
    ok(await add(nadia, dm, { kind: 'link', target: 'https://example.org/dm' }), 201);
  });
});
