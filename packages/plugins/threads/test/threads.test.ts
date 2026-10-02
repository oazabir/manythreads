import { randomUUID } from 'node:crypto';
import {
  FollowThreadResponse,
  GetThreadResponse,
  ListThreadsResponse,
  type ThreadsTab,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from '../../channels/test/world.ts';

const { omar, nadia, rafi, sameera, priya, lena } = personas;

let w: World;
let dev = '';
let releases = '';
let general = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  releases = await w.channelId('engineering', 'releases');
  general = await w.channelId('engineering', 'general');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const post = async (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> =>
  ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId }), 201).id;
const inbox = async (who: Persona, tab: ThreadsTab, slug = 'engineering', query = ''): Promise<ListThreadsResponse> =>
  ListThreadsResponse.parse(ok(await w.call(who, 'GET', `/api/teams/${slug}/threads?tab=${tab}${query}`)));
const roots = async (who: Persona, tab: ThreadsTab, slug = 'engineering'): Promise<string[]> =>
  (await inbox(who, tab, slug, '&limit=100')).items.map((i) => i.rootMessageId);
const thread = async (who: Persona, rootId: string, query = ''): Promise<GetThreadResponse> =>
  GetThreadResponse.parse(ok(await w.call(who, 'GET', `/api/threads/${rootId}${query}`)));
const follows = (rootId: string): Promise<string[]> =>
  w.system(async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.thread_follows WHERE thread_root_id = $1 ORDER BY person_id', [rootId])).rows.map((r) => r.person_id));
const mirrored = (rootId: string): Promise<string[]> =>
  w.system(async (tx) => (await tx.query<{ person_id: string }>(
    "SELECT person_id FROM app.read_state WHERE target_type = 'thread' AND target_id = $1 AND followed ORDER BY person_id", [rootId])).rows.map((r) => r.person_id));
const markRead = (who: Persona, rootId: string, upTo: string): Promise<ApiResult> =>
  w.call(who, 'POST', '/api/read-state/mark', { targetType: 'thread', targetId: rootId, upTo });
const sorted = (...p: Persona[]): string[] => p.map((x) => x.personId as string).sort();

describe('the Threads inbox: membership of each tab (criterion 4)', () => {
  let root = '';
  let reply = '';
  let lonely = '';
  beforeAll(async () => {
    root = await post(nadia, dev, 'Deploy plan for Friday');
    lonely = await post(rafi, dev, 'A message nobody answered');
    reply = await post(rafi, dev, 'I can take the rollback part', root);
  });

  it('Followed lists the threads a person follows; a root with no reply is not a thread yet', async () => {
    expect(await roots(nadia, 'followed')).toEqual([root]);      // the root's author follows from the first reply
    expect(await roots(rafi, 'followed')).toEqual([root]);       // replying follows
    expect(await roots(priya, 'followed')).toEqual([]);
    expect(await roots(rafi, 'followed')).not.toContain(lonely);
  });

  it('Unread lists the threads with replies the person has not read, and only those', async () => {
    const nadiaUnread = await inbox(nadia, 'unread');
    expect(nadiaUnread.items.map((i) => [i.rootMessageId, i.unreadCount])).toEqual([[root, 1]]);
    expect(await roots(rafi, 'unread')).toEqual([]);               // his own reply is not unread for him
    expect(await roots(priya, 'unread')).toEqual([]);
    ok(await markRead(nadia, root, reply));
    expect(await roots(nadia, 'unread')).toEqual([]);
    expect(await roots(nadia, 'followed')).toEqual([root]);        // read is not unfollowed
    await post(rafi, dev, 'Second reply', root);
    expect((await inbox(nadia, 'unread')).items[0]?.unreadCount).toBe(1);
  });

  it('Mine lists the threads a person started', async () => {
    expect(await roots(nadia, 'mine')).toEqual([root]);
    expect(await roots(rafi, 'mine')).toEqual([]);                 // he started `lonely`, which has no reply, and only replied to the other
    const item = (await inbox(nadia, 'mine')).items[0]!;
    expect(item).toMatchObject({ mine: true, followed: true, title: 'Deploy plan for Friday', replyCount: 2 });
    expect(item.channel).toMatchObject({ id: dev, name: 'dev', kind: 'channel' });
    await post(nadia, dev, 'nobody answers me', null);
    expect(await roots(nadia, 'mine')).toEqual([root]);
  });

  it('is limited to the team in the path: another team, an unknown team and an outsider each get an empty inbox (200)', async () => {
    expect(await roots(nadia, 'followed', 'marketing')).toEqual([]);
    expect(await roots(nadia, 'followed', 'no-such-team')).toEqual([]);
    expect(await roots(sameera, 'followed', 'engineering')).toEqual([]);
    expect((await w.call(null, 'GET', '/api/teams/engineering/threads')).status).toBe(401);
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/threads?tab=bogus')).status).toBe(400);
  });

  it('sorts by the latest reply and pages by cursor without gaps or repeats', async () => {
    const support = await w.channelId('customer-support', 'support');
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await post(sameera, support, `Topic ${i}`);
      await post(sameera, support, `answer ${i}`, r);
      made.push(r);
    }
    // The oldest thread gets a fresh reply: it moves to the top.
    await post(sameera, support, 'one more', made[0]!);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ListThreadsResponse = await inbox(sameera, 'followed', 'customer-support', `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...page.items.map((i) => i.rootMessageId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([made[0], made[4], made[3], made[2], made[1]]);
    expect((await w.call(sameera, 'GET', '/api/teams/customer-support/threads?cursor=garbage')).status).toBe(400);
  });
});

describe('following (one source of truth: thread_follows, mirrored into read_state)', () => {
  let root = '';
  beforeAll(async () => {
    root = await post(nadia, dev, 'Follow semantics');
  });

  it('a reply makes the replier and the root author follow, mirrored into the read state', async () => {
    expect(await follows(root)).toEqual([]);
    await post(rafi, dev, 'first reply', root);
    expect(await follows(root)).toEqual(sorted(nadia, rafi));
    expect(await mirrored(root)).toEqual(sorted(nadia, rafi));
  });

  it('follow and unfollow are idempotent and move membership, the mirror and the tabs together', async () => {
    expect(ok(await w.call(priya, 'POST', `/api/threads/${root}/follow`))).toEqual({ followed: true, changed: true });
    expect(ok(await w.call(priya, 'POST', `/api/threads/${root}/follow`))).toEqual({ followed: true, changed: false });
    expect(await follows(root)).toEqual(sorted(nadia, rafi, priya));
    expect(await mirrored(root)).toEqual(sorted(nadia, rafi, priya));
    expect(await roots(priya, 'followed')).toContain(root);
    expect((await thread(priya, root)).thread.followed).toBe(true);

    await post(rafi, dev, 'second reply', root);
    expect((await inbox(priya, 'unread')).items.find((i) => i.rootMessageId === root)?.unreadCount).toBe(1);

    expect(FollowThreadResponse.parse(ok(await w.call(priya, 'POST', `/api/threads/${root}/unfollow`)))).toEqual({ followed: false, changed: true });
    expect(ok(await w.call(priya, 'POST', `/api/threads/${root}/unfollow`))).toEqual({ followed: false, changed: false });
    expect(await follows(root)).toEqual(sorted(nadia, rafi));
    expect(await mirrored(root)).toEqual(sorted(nadia, rafi));
    expect(await roots(priya, 'followed')).not.toContain(root);
    // Not following means not being told: what was counted unread is cleared, so the tab and the badge agree.
    expect(await roots(priya, 'unread')).not.toContain(root);
    expect((await thread(priya, root)).thread).toMatchObject({ followed: false, unreadCount: 0 });
  });

  it('a later reply by someone else does not bring back a follow that was given up, but replying yourself does', async () => {
    ok(await w.call(nadia, 'POST', `/api/threads/${root}/unfollow`));      // the root author steps out
    expect(await follows(root)).toEqual(sorted(rafi));
    await post(rafi, dev, 'third reply', root);
    expect(await follows(root)).toEqual(sorted(rafi));
    expect(await roots(nadia, 'unread')).not.toContain(root);
    await post(nadia, dev, 'ok, back in', root);                           // replying follows
    expect(await follows(root)).toEqual(sorted(nadia, rafi));
    expect(await mirrored(root)).toEqual(sorted(nadia, rafi));
  });

  it('following needs a message the person can read and a root, not a reply; a bot or a stranger is refused', async () => {
    const hidden = await post(omar, general, 'public');                      // readable by Engineering, not by Sameera
    expect((await w.call(sameera, 'POST', `/api/threads/${hidden}/follow`)).status).toBe(403);
    const reply = await post(rafi, dev, 'a reply', root);
    expect((await w.call(priya, 'POST', `/api/threads/${reply}/follow`)).status).toBe(404);
    expect((await w.call(priya, 'POST', '/api/threads/00000000-0000-7000-8000-000000000000/follow')).status).toBe(403);
    expect((await w.call(priya, 'POST', '/api/threads/not-a-uuid/follow')).status).toBe(400);
    expect((await w.call(null, 'POST', `/api/threads/${root}/follow`)).status).toBe(401);
  });

  it('a person can follow a message before anyone replied; the first reply then lists the thread for them', async () => {
    const fresh = await post(nadia, dev, 'Anyone seen the alert?');
    ok(await w.call(priya, 'POST', `/api/threads/${fresh}/follow`));
    expect(await roots(priya, 'followed')).not.toContain(fresh);
    await post(rafi, dev, 'yes', fresh);
    expect(await roots(priya, 'followed')).toContain(fresh);
    expect((await inbox(priya, 'unread')).items.find((i) => i.rootMessageId === fresh)?.unreadCount).toBe(1);
  });
});

describe('GET /api/threads/:rootId', () => {
  let root = '';
  const replies: string[] = [];
  beforeAll(async () => {
    root = await post(nadia, dev, 'Reading a thread');
    for (let i = 0; i < 5; i += 1) replies.push(await post(i % 2 ? nadia : rafi, dev, `reply ${i}`, root));
    ok(await w.call(priya, 'POST', `/api/channels/${dev}/messages/${replies[4]}/reactions`, { emoji: '👍' }));
    ok(await w.call(rafi, 'DELETE', `/api/channels/${dev}/messages/${replies[0]}`));
  });

  it('serves the root, the channel, the caller state and the replies newest first, paged by cursor', async () => {
    const first = await thread(nadia, root, '?limit=2');
    expect(first.root).toMatchObject({ id: root, body: 'Reading a thread', replyCount: 4 });
    expect(first.channel).toMatchObject({ id: dev, name: 'dev', kind: 'channel', private: false });
    expect(first.thread).toMatchObject({ rootMessageId: root, replyCount: 4, followed: true, title: 'Reading a thread' });
    expect(first.thread.lastReplyAt).not.toBeNull();
    expect(first.replies.items.map((r) => r.id)).toEqual([replies[4], replies[3]]);
    expect(first.replies.items[0]?.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    const second = await thread(nadia, root, `?limit=2&before=${first.replies.nextCursor}`);
    expect(second.replies.items.map((r) => r.id)).toEqual([replies[2], replies[1]]);      // the deleted reply is left out
    expect(second.replies.nextCursor).toBeNull();
    expect((await thread(priya, root)).thread.followed).toBe(false);
  });

  it('a message without replies opens as an empty thread; a reply is not a thread', async () => {
    const bare = await post(nadia, dev, 'Just a message');
    const t = await thread(rafi, bare);
    expect(t.replies).toEqual({ items: [], nextCursor: null });
    expect(t.thread).toMatchObject({ replyCount: 0, lastReplyAt: null, followed: false, unreadCount: 0 });
    expect((await w.call(rafi, 'GET', `/api/threads/${replies[1]}`)).status).toBe(404);
  });

  it('carries the attachment cards of the root and of replies, for the files the caller may read', async () => {
    const withFile = await post(nadia, dev, 'Report attached');
    const answer = await post(rafi, dev, 'got it', withFile);
    const fileId = await w.system(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO app.files (workspace_id, team_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
       SELECT $1, c.team_id, c.id, 'channels/dev/', 'report.pdf', 'k1', 2048, 'application/pdf', repeat('a', 64), $3 FROM app.channels c WHERE c.id = $2
       RETURNING id`, [nadia.workspaceId, dev, nadia.actorId])).rows[0]!.id);
    await w.system((tx) => tx.query("UPDATE app.messages SET meta = $2::jsonb WHERE id = $1", [withFile, JSON.stringify({ attachments: [fileId] })]));
    await w.system((tx) => tx.query("UPDATE app.messages SET meta = $2::jsonb WHERE id = $1", [answer, JSON.stringify({ attachments: [fileId, randomUUID()] })]));
    const t = await thread(rafi, withFile);
    expect(t.root.attachments).toEqual([{ id: fileId, name: 'report.pdf', size: 2048, mime: 'application/pdf' }]);
    expect(t.replies.items[0]?.attachments).toEqual([{ id: fileId, name: 'report.pdf', size: 2048, mime: 'application/pdf' }]);   // the unknown id is left out
  });

  it('is 403 for a thread in a channel the caller cannot read, and the same for one that does not exist', async () => {
    const priv = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'thread-private', private: true }), 201).channel.id;
    const secret = await post(omar, priv, 'secret');
    await post(omar, priv, 'secret reply', secret);
    expect((await w.call(nadia, 'GET', `/api/threads/${secret}`)).status).toBe(403);
    expect((await w.call(nadia, 'GET', '/api/threads/00000000-0000-7000-8000-000000000000')).status).toBe(403);
    expect((await w.call(null, 'GET', `/api/threads/${secret}`)).status).toBe(401);
    expect(await roots(nadia, 'followed')).not.toContain(secret);
    expect((await w.call(nadia, 'POST', `/api/threads/${secret}/follow`)).status).toBe(403);
  });

  it('a guest reads a thread of the channel they were granted and of no other', async () => {
    await w.system((tx) => tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
       VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING`, [lena.workspaceId, releases, lena.personId]));
    const r = await post(nadia, releases, 'Release notes');
    await post(rafi, releases, 'looks good', r);
    expect((await thread(lena, r)).root.id).toBe(r);
    expect((await w.call(lena, 'GET', `/api/threads/${root}`)).status).toBe(403);
    expect(await roots(lena, 'followed', 'whatever')).toEqual([]);
    ok(await w.call(lena, 'POST', `/api/threads/${r}/follow`));
    expect(await roots(lena, 'followed', 'whatever')).toEqual([r]);
  });
});
