import { ListSavedBookmarksResponse, ListThreadsResponse, SAVED_BOOKMARKS_FULL, SavedBookmark, SavedBookmarkKeysResponse, type BookmarkTarget } from '@manythreads/shared';
import { testClient } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, priya } = personas;

// P36-08: bookmarks through the HTTP routes, and the Threads view's Bookmarked filter (threads plugin, through `provider.bookmarks`). DB-backed: runs on
// the devbox when no CI run shares the database.

let w: World;
let dev = '';
let hidden = '';
let botActor = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  // a private channel of Engineering with Nadia and Rafi in it (Nadia leaves it below)
  hidden = await w.system(async (tx) => {
    const team = (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id;
    const id = (
      await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, 'bm-hidden', 'channel', true, $3) RETURNING id", [omar.workspaceId, team, omar.actorId])
    ).rows[0]!.id;
    for (const p of [nadia, rafi]) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, p.personId]);
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'bmbot', 'BmBot', '', 'agent', 'rules', 'team', repeat('e', 64), 'active') RETURNING id`,
      [omar.workspaceId, team],
    );
    botActor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot.rows[0]!.id])).rows[0]!.id;
    return id;
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const post = async (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> =>
  ok(await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId }), 201).id;
const put = (who: Persona, target: BookmarkTarget | Record<string, unknown>): Promise<ApiResult<SavedBookmark>> => w.call(who, 'PUT', '/api/bookmarks', { target });
const list = async (who: Persona, query = ''): Promise<ListSavedBookmarksResponse> => ListSavedBookmarksResponse.parse(ok(await w.call(who, 'GET', `/api/bookmarks${query}`)));
const keys = async (who: Persona): Promise<SavedBookmarkKeysResponse> => SavedBookmarkKeysResponse.parse(ok(await w.call(who, 'GET', '/api/bookmarks/keys')));
const remove = (who: Persona, id: string): Promise<ApiResult<{ removed: boolean }>> => w.call(who, 'DELETE', `/api/bookmarks/${id}`);
const threads = async (who: Persona, query: string): Promise<string[]> =>
  ListThreadsResponse.parse(ok(await w.call(who, 'GET', `/api/teams/engineering/threads?${query}`))).items.map((i) => i.rootMessageId);
const clearAll = async (who: Persona): Promise<void> => {
  for (const k of (await keys(who)).items) ok(await remove(who, k.id));
};

describe('bookmarking a thread and a message', () => {
  it('a thread: 201 with the item (title, place, replies), again a 200 with the same bookmark and no second row', async () => {
    const root = await post(nadia, dev, 'Release plan for **Friday**');
    await post(rafi, dev, 'I take the notes', root);
    const created = SavedBookmark.parse(ok(await put(omar, { kind: 'thread', rootMessageId: root }), 201));
    expect(created.target).toEqual({ kind: 'thread', rootMessageId: root });
    expect(created.item).toMatchObject({ kind: 'thread', rootAuthorName: 'Nadia', snippet: 'Release plan for Friday', replyCount: 1 });
    expect(created.item?.channel).toMatchObject({ id: dev, name: 'dev', kind: 'channel' });
    const again = SavedBookmark.parse(ok(await put(omar, { kind: 'thread', rootMessageId: root }), 200));
    expect(again.id).toBe(created.id);
    expect((await keys(omar)).items.filter((k) => k.key === root)).toEqual([{ id: created.id, kind: 'thread', key: root }]);
  });

  it('a message and a thread reply: the reply keeps its thread so it opens there', async () => {
    const root = await post(nadia, dev, 'a root to reply to');
    const reply = await post(rafi, dev, 'the reply worth keeping', root);
    const b = SavedBookmark.parse(ok(await put(nadia, { kind: 'message', messageId: reply }), 201));
    expect(b.item).toMatchObject({ kind: 'message', threadRootId: root, authorName: 'Rafi', snippet: 'the reply worth keeping' });
    const plain = SavedBookmark.parse(ok(await put(nadia, { kind: 'message', messageId: root }), 201));
    expect(plain.item).toMatchObject({ kind: 'message', threadRootId: null });
    // a reply is not a thread
    expect((await put(nadia, { kind: 'thread', rootMessageId: reply })).status).toBe(400);
  });

  it('refuses what the caller cannot see (403), what is gone (404), files for now (400), a bot (403) and an unknown shape (400)', async () => {
    const secret = await w.system(async (tx) => {
      const ch = (await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) SELECT $1, id, 'bm-omar-only', 'channel', true, $2 FROM app.teams WHERE slug = 'engineering' RETURNING id", [omar.workspaceId, omar.actorId])).rows[0]!.id;
      return (await tx.query<{ id: string }>("INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'secret canary', 'secret canary') RETURNING id", [omar.workspaceId, ch, omar.actorId])).rows[0]!.id;
    });
    expect((await put(rafi, { kind: 'message', messageId: secret })).status).toBe(403);
    expect((await put(rafi, { kind: 'thread', rootMessageId: secret })).status).toBe(403);
    expect((await put(rafi, { kind: 'message', messageId: crypto.randomUUID() })).status).toBe(403);
    const gone = await post(rafi, dev, 'soon deleted');
    ok(await w.call(rafi, 'DELETE', `/api/channels/${dev}/messages/${gone}`));
    expect((await put(rafi, { kind: 'message', messageId: gone })).status).toBe(404);
    expect((await put(rafi, { kind: 'file', fileId: crypto.randomUUID() })).status).toBe(400);
    expect((await put(rafi, { kind: 'repo_file', teamId: crypto.randomUUID(), path: 'README.md' })).status).toBe(400);
    expect((await put(rafi, { kind: 'pin', messageId: gone })).status).toBe(400);
    const asBot = await fetch(`${w.server.url}/api/bookmarks/keys`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'bot', id: botActor, workspaceId: omar.workspaceId }) } });
    expect(asBot.status).toBe(403);
  });
});

describe('the list', () => {
  it('is private: nobody else sees a bookmark, an admin included', async () => {
    const id = await post(nadia, dev, 'only for priya');
    const mine = SavedBookmark.parse(ok(await put(priya, { kind: 'message', messageId: id }), 201));
    expect((await list(priya)).items.some((b) => b.id === mine.id)).toBe(true);
    expect((await list(nadia)).items.some((b) => b.id === mine.id)).toBe(false);
    expect((await list(omar)).items.some((b) => b.id === mine.id)).toBe(false);
    expect((await remove(omar, mine.id)).status).toBe(404);
    ok(await remove(priya, mine.id));
    expect((await remove(priya, mine.id)).status).toBe(404);
  });

  it('counts each tab, filters by tab and pages newest first', async () => {
    await clearAll(rafi);
    const ids: string[] = [];
    for (const text of ['one', 'two', 'three']) ids.push(await post(nadia, dev, `paging ${text}`));
    for (const id of ids) ok(await put(rafi, { kind: 'message', messageId: id }), 201);
    const root = await post(nadia, dev, 'paging thread');
    await post(nadia, dev, 'a reply', root);
    ok(await put(rafi, { kind: 'thread', rootMessageId: root }), 201);
    const all = await list(rafi);
    expect(all.counts).toEqual({ thread: 1, message: 3, file: 0 });
    expect(all.items[0]?.target).toEqual({ kind: 'thread', rootMessageId: root });
    const first = await list(rafi, '?kind=message&limit=2');
    expect(first.items.map((b) => (b.target.kind === 'message' ? b.target.messageId : ''))).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(rafi, `?kind=message&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((b) => (b.target.kind === 'message' ? b.target.messageId : ''))).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    expect((await list(rafi, '?kind=thread')).items).toHaveLength(1);
    expect((await keys(rafi)).total).toBe(4);
  });

  it('keeps what the caller can no longer read as item: null, with nothing of it in the answer', async () => {
    await clearAll(nadia);
    const kept = await post(rafi, hidden, 'canary-hidden-words in a private channel');
    const keptRoot = await post(rafi, hidden, 'canary-thread-words root');
    await post(rafi, hidden, 'canary-reply-words', keptRoot);
    ok(await put(nadia, { kind: 'message', messageId: kept }), 201);
    ok(await put(nadia, { kind: 'thread', rootMessageId: keptRoot }), 201);
    const deleted = await post(nadia, dev, 'canary-deleted-words');
    ok(await put(nadia, { kind: 'message', messageId: deleted }), 201);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${deleted}`));
    await w.system((tx) => tx.query('DELETE FROM app.channel_members WHERE channel_id = $1 AND person_id = $2', [hidden, nadia.personId]));
    const res = await w.call(nadia, 'GET', '/api/bookmarks');
    const parsed = ListSavedBookmarksResponse.parse(ok(res));
    expect(parsed.items).toHaveLength(3);
    for (const b of parsed.items) expect(b.item).toBeNull();
    const raw = JSON.stringify(res.body);
    for (const word of ['canary', 'bm-hidden', 'Rafi', hidden]) expect(raw).not.toContain(word);
    // she can still remove them
    for (const b of parsed.items) ok(await remove(nadia, b.id));
    expect((await keys(nadia)).total).toBe(0);
  });

  it('a full list says so (409) and still answers a bookmark already there', async () => {
    await clearAll(priya);
    const id = await post(nadia, dev, 'the one already kept');
    ok(await put(priya, { kind: 'message', messageId: id }), 201);
    // the system role has no policy on bookmarks (nothing but the person ever touches them): the owner role fills the list
    const owner = testClient({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    try {
      await owner.query(
        `INSERT INTO app.bookmarks (workspace_id, person_id, kind, message_id, channel_id) SELECT $1::uuid, $2::uuid, 'message', uuidv7(), $3::uuid FROM generate_series(1, 499)`,
        [priya.workspaceId, priya.personId, dev],
      );
    } finally {
      await owner.end();
    }
    expect((await keys(priya)).total).toBe(500);
    const more = await post(nadia, dev, 'one too many');
    const refused = await put(priya, { kind: 'message', messageId: more });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(SAVED_BOOKMARKS_FULL);
    expect((await put(priya, { kind: 'message', messageId: id })).status).toBe(200);
  });
});

describe('live updates', () => {
  it('pushes bookmarks.changed to the person only, after the change is committed', async () => {
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const others: Array<{ type: string }> = [];
    const open = async (who: Persona, into: Array<{ type: string; payload?: Record<string, unknown> }>): Promise<WebSocket> => {
      const header = JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId });
      const ws = new WebSocket(w.server.url.replace('http', 'ws') + '/ws', { headers: { 'x-manythreads-dev-actor': header } } as never);
      ws.onmessage = (e) => void into.push(JSON.parse(String(e.data)) as { type: string; payload: Record<string, unknown> });
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('socket failed to open'));
      });
      return ws;
    };
    const mine = await open(rafi, frames);
    const theirs = await open(nadia, others as never);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const id = await post(nadia, dev, 'pushed bookmark');
      const b = SavedBookmark.parse(ok(await put(rafi, { kind: 'message', messageId: id }), 201));
      const on = await eventually(async () => frames.find((f) => f.type === 'bookmarks.changed' && f.payload['id'] === b.id), 10_000, 'the push');
      expect(on.payload).toEqual({ id: b.id, kind: 'message', key: id, on: true });
      ok(await remove(rafi, b.id));
      const off = await eventually(async () => frames.find((f) => f.type === 'bookmarks.changed' && f.payload['on'] === false && f.payload['id'] === b.id), 10_000, 'the removal push');
      expect(off.payload).toEqual({ id: b.id, kind: 'message', key: id, on: false });
      // a refused write pushes nothing
      const before = frames.filter((f) => f.type === 'bookmarks.changed').length;
      expect((await put(rafi, { kind: 'message', messageId: crypto.randomUUID() })).status).toBe(403);
      await new Promise((r) => setTimeout(r, 500));
      expect(frames.filter((f) => f.type === 'bookmarks.changed')).toHaveLength(before);
      expect(others.some((f) => f.type === 'bookmarks.changed')).toBe(false);
    } finally {
      mine.close();
      theirs.close();
    }
  });
});

describe('the Threads view Bookmarked filter', () => {
  let followed = '';
  let notFollowed = '';
  let botThread = '';
  beforeAll(async () => {
    await clearAll(omar);
    // Nadia starts two threads and Rafi replies; Omar follows neither. A third has a reply from a bot.
    followed = await post(nadia, dev, 'bmfilter alpha thread');
    await post(rafi, dev, 'alpha reply', followed);
    notFollowed = await post(nadia, dev, 'bmfilter beta thread');
    await post(rafi, dev, 'beta reply', notFollowed);
    botThread = await post(nadia, dev, 'bmfilter gamma thread');
    await w.system((tx) =>
      tx.query("INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'bot says', 'bot says', $4)", [omar.workspaceId, dev, botActor, botThread]),
    );
    ok(await w.call(omar, 'POST', `/api/threads/${followed}/follow`));
    for (const root of [followed, notFollowed, botThread]) ok(await put(omar, { kind: 'thread', rootMessageId: root }), 201);
  });

  it('on Followed lists every bookmarked thread, followed or not, and nothing else', async () => {
    const all = await threads(omar, 'tab=followed&bookmarked=1');
    expect(new Set(all)).toEqual(new Set([followed, notFollowed, botThread]));
    // without the filter, the one he does not follow is not on Followed
    const plain = await threads(omar, 'tab=followed');
    expect(plain).toContain(followed);
    expect(plain).not.toContain(notFollowed);
  });

  it('lists a bookmarked first message with no reply yet, as a thread with no replies, and keeps the pages', async () => {
    const lonely = await post(nadia, dev, 'bmfilter delta no replies yet');
    ok(await put(omar, { kind: 'thread', rootMessageId: lonely }), 201);
    const res = ListThreadsResponse.parse(ok(await w.call(omar, 'GET', '/api/teams/engineering/threads?tab=followed&bookmarked=1')));
    const item = res.items.find((i) => i.rootMessageId === lonely);
    expect(item).toMatchObject({ replyCount: 0, lastReply: null });
    // newest first: the lonely one was written last
    expect(res.items[0]?.rootMessageId).toBe(lonely);
    expect(await threads(omar, 'tab=followed&bookmarked=1&q=delta')).toEqual([lonely]);
    expect(await threads(omar, 'tab=mine&bookmarked=1')).toEqual([]);
    expect(await threads(nadia, 'tab=followed')).not.toContain(lonely); // never on a list without the filter
    // pages of one: every bookmarked thread once, in order, then no cursor
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page = ListThreadsResponse.parse(ok(await w.call(omar, 'GET', `/api/teams/engineering/threads?tab=followed&bookmarked=1&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)));
      seen.push(...page.items.map((x) => x.rootMessageId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(res.items.map((x) => x.rootMessageId));
    expect(new Set(seen)).toEqual(new Set([lonely, followed, notFollowed, botThread]));
    // a deleted root with no replies drops out
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${lonely}`));
    expect(await threads(omar, 'tab=followed&bookmarked=1')).not.toContain(lonely);
  });

  it('combines with the words of the filter and with People only', async () => {
    expect(await threads(omar, 'tab=followed&bookmarked=1&q=beta')).toEqual([notFollowed]);
    expect(await threads(omar, 'tab=followed&bookmarked=1&q=nothing-matches')).toEqual([]);
    expect(new Set(await threads(omar, 'tab=followed&bookmarked=1&who=people'))).toEqual(new Set([followed, notFollowed]));
  });

  it('narrows Mine and Unread to their own rule', async () => {
    // Nadia started all three but bookmarked only one
    ok(await put(nadia, { kind: 'thread', rootMessageId: notFollowed }), 201);
    expect(await threads(nadia, 'tab=mine&bookmarked=1')).toEqual([notFollowed]);
    expect(await threads(omar, 'tab=mine&bookmarked=1')).toEqual([]);
    const unread = await threads(omar, 'tab=unread&bookmarked=1');
    const unreadAll = await threads(omar, 'tab=unread');
    for (const id of unread) expect(unreadAll).toContain(id);
  });

  it('a person with no bookmarks gets an empty list, never the whole tab', async () => {
    // Priya's list was filled to 500 above: empty it at once (removing each would run into the route's rate limit)
    const owner = testClient({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('DELETE FROM app.bookmarks WHERE person_id = $1', [priya.personId]);
    } finally {
      await owner.end();
    }
    expect((await keys(priya)).total).toBe(0);
    ok(await w.call(priya, 'POST', `/api/threads/${followed}/follow`));
    expect(await threads(priya, 'tab=followed')).toContain(followed);
    expect(await threads(priya, 'tab=followed&bookmarked=1')).toEqual([]);
  });
});
