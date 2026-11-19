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
    // the row shows who spoke last and what they said (the newest live reply, named for what the caller may read)
    expect(item.lastReply).toMatchObject({ authorName: rafi.name, preview: 'Second reply', authorId: rafi.actorId, kind: 'person' });
    expect(item.lastReply?.at).toMatch(/^\d{4}-/);
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

describe('the inbox row: who is in the thread, and whether a reply names the reader', () => {
  let root = '';
  beforeAll(async () => {
    root = await post(nadia, dev, 'Which region do we cut over first?');
    await post(rafi, dev, 'EU, it has the least traffic', root);
    await post(priya, dev, 'Agreed, EU first', root);
  });

  it('names the root author and lists the writers: the root author first, then the newest', async () => {
    const item = (await inbox(nadia, 'followed')).items.find((i) => i.rootMessageId === root)!;
    expect(item.rootAuthor).toMatchObject({ displayName: nadia.name, kind: 'person' });
    expect(item.participants.map((p) => p.displayName)).toEqual([nadia.name, priya.name, rafi.name]);
    expect(item.participantCount).toBe(3);
  });

  it('counts the unread replies that tag the reader, and only until they are read', async () => {
    const tagged = await post(rafi, dev, `@${nadia.name.split(' ')[0]!.toLowerCase()} can you confirm the date?`, root);
    await post(priya, dev, 'also an untagged reply', root);
    const before = (await inbox(nadia, 'unread')).items.find((i) => i.rootMessageId === root)!;
    expect(before.unreadCount).toBeGreaterThanOrEqual(2);
    expect(before.mentionCount).toBe(1);
    expect((await inbox(rafi, 'followed')).items.find((i) => i.rootMessageId === root)?.mentionCount).toBe(0);
    ok(await markRead(nadia, root, tagged));
    const after = (await inbox(nadia, 'followed')).items.find((i) => i.rootMessageId === root)!;
    expect(after.mentionCount).toBe(0);
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

describe('the Threads view (P29): the filter, "waiting for you" and the sidebar count', () => {
  const first = (p: Persona): string => p.name.split(' ')[0]!.toLowerCase();
  let rootA = '';
  let rootB = '';
  let mentionId = '';
  beforeAll(async () => {
    rootA = await post(priya, releases, 'Zebrafish migration window');
    mentionId = await post(rafi, releases, `@${first(priya)} please pick the window, the quokka dashboard is ready`, rootA);
    rootB = await post(priya, dev, 'Plain thread about quokka caching');
    await post(nadia, dev, 'no tags here', rootB);
  });
  const counts = async (who: Persona, slug = 'engineering'): Promise<number> => ok<{ mentions: number }>(await w.call(who, 'GET', `/api/teams/${slug}/threads/counts`)).mentions;

  it('puts the newest unanswered mention on the row, and the thread in the default tab even when not followed', async () => {
    await w.system((tx) => tx.query('DELETE FROM app.thread_follows WHERE person_id = $1 AND thread_root_id = $2', [priya.personId, rootA]));
    const row = (await inbox(priya, 'followed')).items.find((i) => i.rootMessageId === rootA)!;
    expect(row.followed).toBe(false);
    expect(row.mention).toMatchObject({ messageId: mentionId, authorId: rafi.actorId, authorName: rafi.name, kind: 'person' });
    expect(row.mention?.preview).toContain('quokka dashboard');
    expect((await inbox(priya, 'followed')).items.find((i) => i.rootMessageId === rootB)?.mention ?? null).toBeNull();
    expect(await counts(priya)).toBe(1);
    expect(await counts(rafi)).toBe(0);
  });

  it('stops waiting once the person writes in the thread, and a new mention waits again', async () => {
    await post(priya, releases, 'on it, window is Friday', rootA);
    expect((await inbox(priya, 'followed')).items.find((i) => i.rootMessageId === rootA)?.mention ?? null).toBeNull();
    expect(await counts(priya)).toBe(0);
    const again = await post(nadia, releases, `@${first(priya)} thanks, confirm in the morning`, rootA);
    expect((await inbox(priya, 'followed')).items.find((i) => i.rootMessageId === rootA)?.mention?.messageId).toBe(again);
    expect(await counts(priya)).toBe(1);
  });

  it('does not count a #channel link, an old mention, a deleted message or a thread of another team', async () => {
    const r = await post(nadia, dev, 'Channel-wide notice');
    await post(rafi, dev, 'see #releases', r);
    expect((await inbox(priya, 'followed')).items.find((i) => i.rootMessageId === r)?.mention ?? null).toBeNull();
    const old = await post(nadia, dev, `@${first(priya)} an old question`, rootB);
    await w.system((tx) => tx.query("UPDATE app.messages SET created_at = now() - interval '9 days' WHERE id = $1", [old]));
    expect((await inbox(priya, 'followed')).items.find((i) => i.rootMessageId === rootB)?.mention ?? null).toBeNull();
    const gone = await post(nadia, dev, `@${first(priya)} deleted soon`, rootB);
    await w.system((tx) => tx.query('UPDATE app.messages SET deleted_at = now() WHERE id = $1', [gone]));
    expect((await inbox(priya, 'followed')).items.find((i) => i.rootMessageId === rootB)?.mention ?? null).toBeNull();
    expect(await counts(priya, 'marketing')).toBe(0);
    expect(await counts(sameera)).toBe(0);
    expect((await w.call(null, 'GET', '/api/teams/engineering/threads/counts')).status).toBe(401);
  });

  it('filters by words in the channel name or a message, channel-name matches first, and by @name', async () => {
    const q = async (who: Persona, query: string): Promise<string[]> => (await inbox(who, 'followed', 'engineering', `&${query}`)).items.map((i) => i.rootMessageId);
    // "releases" is a channel name (rootA) and also a word in a message of rootC
    const rootC = await post(nadia, dev, 'Notes for the next releases');
    await post(rafi, dev, 'ok', rootC);
    await w.system((tx) => tx.query('UPDATE app.messages SET created_at = created_at WHERE id = $1', [rootC]));
    expect(await q(priya, 'q=quokka')).toEqual(expect.arrayContaining([rootA, rootB]));
    expect(await q(priya, 'q=zebrafish+quokka')).toEqual([rootA]);                 // every word must match
    const named = await q(nadia, 'q=releases');
    expect(named.indexOf(rootA)).toBeGreaterThanOrEqual(0);
    expect(named.indexOf(rootA)).toBeLessThan(named.indexOf(rootC));               // the channel's name before a message
    expect(await q(priya, 'q=no-such-word-anywhere')).toEqual([]);
    // rootB holds an old mention of her too: the @name filter is any mention, "waiting" is a separate rule
    expect(await q(priya, `mentions=${priya.actorId as string}`)).toEqual(expect.arrayContaining([rootA, rootB]));
    expect(await q(priya, `mentions=${priya.actorId as string}&q=zebrafish`)).toEqual([rootA]);
    expect(await q(nadia, `mentions=${priya.actorId as string}`)).not.toContain(rootC);
    // one name that may mean two people: either of them
    expect(await q(priya, `mentions=${lena.actorId as string}|${priya.actorId as string}&q=zebrafish`)).toEqual([rootA]);
    expect(await q(priya, `mentions=${lena.actorId as string}|${priya.actorId as string},${priya.actorId as string}&q=zebrafish`)).toEqual([rootA]);
    expect(await q(priya, `mentions=${lena.actorId as string}|${omar.actorId as string}&q=zebrafish`)).toEqual([]);
    // a wildcard typed by a person is text, not a pattern
    expect(await q(priya, 'q=%25')).toEqual([]);
    expect(await q(priya, 'q=_')).toEqual([]);
    // a filtered answer has no cursor
    expect((await inbox(priya, 'followed', 'engineering', '&q=quokka&limit=1')).nextCursor).toBeNull();
    expect((await w.call(priya, 'GET', '/api/teams/engineering/threads?mentions=nope')).status).toBe(400);
  });

  it('people only (owner 2026-11-19): keeps the threads every message of which is by a person, and pages as the plain list does', async () => {
    const q = async (query: string): Promise<string[]> => (await inbox(nadia, 'followed', 'engineering', `&limit=100&${query}`)).items.map((i) => i.rootMessageId);
    const talk = await post(nadia, dev, 'Lunch on Friday?');
    await post(rafi, dev, 'yes', talk);
    const withBot = await post(nadia, dev, 'Build the release notes');
    const botReply = await post(rafi, dev, 'on it', withBot);
    await post(nadia, dev, 'thanks', withBot);
    const botRoot = await post(nadia, dev, 'A root a bot will be said to have written');
    await post(rafi, dev, 'ok', botRoot);
    // a bot (or the system) is the author of one reply and of one root
    await w.system(async (tx) => {
      const ws = (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.messages WHERE id = $1', [withBot])).rows[0]!.workspace_id;
      const other = (await tx.query<{ id: string }>("SELECT id FROM app.actors WHERE kind <> 'person' AND workspace_id = $1 LIMIT 1", [ws])).rows[0]?.id
        ?? (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('system', $1, $1) RETURNING id", [ws])).rows[0]!.id;
      await tx.query('UPDATE app.messages SET author_id = $1 WHERE id = ANY ($2::uuid[])', [other, [botReply, botRoot]]);
    });
    const all = await q('');
    expect(all).toEqual(expect.arrayContaining([talk, withBot, botRoot]));
    const people = await q('who=people');
    expect(people).toContain(talk);
    expect(people).not.toContain(withBot);
    expect(people).not.toContain(botRoot);
    // a deleted bot message no longer counts
    await w.system((tx) => tx.query('UPDATE app.messages SET deleted_at = now() WHERE id = $1', [botReply]));
    expect(await q('who=people')).toContain(withBot);
    // it goes with the words, and keeps the cursor (it is not a capped filter)
    expect(await q('who=people&q=lunch')).toEqual([talk]);
    const page = await inbox(nadia, 'followed', 'engineering', '&who=people&limit=1');
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/threads?who=bots')).status).toBe(400);
  });

  it('matches without regard to accents and case, as the page does: "cafe" finds "Café", "CAFÉ" finds "cafe"', async () => {
    const q = async (who: Persona, query: string): Promise<string[]> => (await inbox(who, 'followed', 'engineering', `&${query}`)).items.map((i) => i.rootMessageId);
    const cafe = await post(priya, dev, 'Le Café Münchner plan for the offsite');
    await post(rafi, dev, 'sounds good, Ñandú too', cafe);
    expect(await q(priya, 'q=cafe')).toContain(cafe);
    expect(await q(priya, `q=${encodeURIComponent('CAFÉ')}`)).toContain(cafe);
    expect(await q(priya, 'q=munchner')).toContain(cafe);
    expect(await q(priya, 'q=nandu')).toContain(cafe);
    expect(await q(priya, 'q=cafes')).not.toContain(cafe);
  });

  it('the mention count is the same number the Needs-you rows show, for each person, however many threads the team has', async () => {
    for (const who of [priya, rafi, nadia, omar]) {
      const rows = (await inbox(who, 'followed', 'engineering', '&limit=100')).items.filter((i) => i.mention !== null).length;
      expect(await counts(who), who.key).toBe(rows);
    }
  });

  it('never leaks a private channel through the filter or the count', async () => {
    const priv = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'filter-private', private: true }), 201).channel.id;
    const secret = await post(omar, priv, `Zebrafish secret plan @${first(nadia)}`);
    await post(omar, priv, `@${first(nadia)} quokka secret`, secret);
    expect(await inbox(nadia, 'followed', 'engineering', '&q=secret')).toMatchObject({ items: [] });
    expect(await inbox(nadia, 'followed', 'engineering', `&mentions=${nadia.actorId as string}`).then((r) => r.items.map((i) => i.rootMessageId))).not.toContain(secret);
    const before = await counts(nadia);
    expect(before).toBe(await counts(nadia));
  });
});

describe('the thread files (P29-20): the side rail\'s Outputs', () => {
  let root = '';
  let channel = '';
  const fileIn = (channelId: string, name: string, mime: string, by: Persona): Promise<string> =>
    w.system(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
         SELECT c.workspace_id, c.id, '/rail/', $2, 'k' || gen_random_uuid(), 2048, $3, repeat('b', 64), $4 FROM app.channels c WHERE c.id = $1 RETURNING id`,
        [channelId, name, mime, by.actorId],
      );
      return r.rows[0]!.id;
    });
  const postWith = async (who: Persona, channelId: string, body: string, attachmentIds: string[], threadRootId: string | null = null): Promise<string> =>
    ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId, attachments: attachmentIds }), 201).id;
  const files = async (who: Persona, rootId: string, query = ''): Promise<{ items: Array<{ file: { name: string; mime: string }; messageId: string; authorName: string; authorKind: string }>; total: number }> =>
    ok(await w.call(who, 'GET', `/api/threads/${rootId}/files${query}`));
  let first = '';
  let second = '';
  beforeAll(async () => {
    channel = await w.channelId('engineering', 'standup');
    const shot = await fileIn(channel, 'before.png', 'image/png', nadia);
    root = await postWith(nadia, channel, 'Here is the screenshot', [shot]);
    first = shot;
    const report = await fileIn(channel, 'report.pdf', 'application/pdf', rafi);
    const clip = await fileIn(channel, 'note.m4a', 'audio/mp4', rafi);
    await post(rafi, channel, 'plain reply, no file', root);
    second = await postWith(rafi, channel, 'And the report', [report, clip], root);
  });

  it('lists the files of the root and the replies, the newest message first, each with its author', async () => {
    const r = await files(nadia, root);
    expect(r.total).toBe(3);
    expect(r.items.map((i) => i.file.name)).toEqual(['report.pdf', 'note.m4a', 'before.png']);
    expect(r.items[0]).toMatchObject({ messageId: second, authorName: expect.stringContaining('Rafi') });
    expect(r.items[2]?.file.mime).toBe('image/png');
    expect(first).not.toBe('');
  });

  it('cuts the list at `limit` and still says how many there are', async () => {
    const r = await files(nadia, root, '?limit=1');
    expect(r.items).toHaveLength(1);
    expect(r.total).toBe(3);
  });

  it('is empty for a thread with no files, and for one the caller cannot read', async () => {
    const plain = await post(nadia, dev, 'No files here');
    expect((await files(nadia, plain)).total).toBe(0);
    const secret = await w.channelId('engineering', 'eng-leads').catch(() => '');
    if (secret) {
      const f = await fileIn(secret, 'private.png', 'image/png', omar);
      const hidden = await postWith(omar, secret, 'Leads only', [f]);
      expect((await files(omar, hidden)).total).toBe(1);
      expect((await files(lena, hidden)).total).toBe(0);
    }
  });
});
