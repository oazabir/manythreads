import { randomUUID } from 'node:crypto';
import {
  Channel,
  ChannelMessage,
  GetChannelResponse,
  ListChannelMembersResponse,
  ListMessagesResponse,
  Message,
  NavChannelDirectory,
  type ListMessagesResponse as ListMessagesResponseType,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type World } from './world.ts';

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;

let w: World;
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const post = (who: typeof nadia | null, channelId: string, body: string, threadRootId: string | null = null): Promise<ApiResult> =>
  w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
const names = (dir: NavChannelDirectory): string[] => dir.groups.flatMap((g) => g.channels.map((c) => c.name));
const directory = async (who: typeof nadia, slug: string): Promise<NavChannelDirectory> =>
  NavChannelDirectory.parse(ok(await w.call(who, 'GET', `/api/teams/${slug}/channels`)));
const grant = (channelId: string, personId: string, permission: 'read' | 'post'): Promise<void> =>
  w.system(async (tx) => {
    await tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
       VALUES ($1, 'channel', $2, 'person', $3, $4) ON CONFLICT DO NOTHING`,
      [lena.workspaceId, channelId, personId, permission],
    );
  });

describe('the sidebar directory (navChannelDirectoryRoute)', () => {
  it('serves the template channels in the shape the shell expects, in template order, in one group', async () => {
    const dir = await directory(nadia, 'engineering');
    expect(dir.groups).toHaveLength(1);
    expect(dir.groups[0]?.name).toBe('Channels');
    expect(names(dir)).toEqual(['general', 'dev', 'releases', 'incidents', 'alerts', 'standup']);
    expect(dir.groups[0]?.channels.every((c) => c.isPrivate === false && c.unread === 0)).toBe(true);
  });

  it('shows a member only the teams they sit in, and nothing (200, not 404) for the others', async () => {
    expect(names(await directory(sameera, 'engineering'))).toEqual([]);
    expect(names(await directory(sameera, 'customer-support'))).toEqual(['support', 'escalations', 'enquiries', 'kb-updates']);
    expect(names(await directory(priya, 'engineering'))).toContain('dev');
    expect(names(await directory(priya, 'marketing')).length).toBeGreaterThan(0);
    expect(names(await directory(nadia, 'no-such-team'))).toEqual([]);
    expect((await w.call(null, 'GET', '/api/teams/engineering/channels')).status).toBe(401);
  });

  it('a guest sees exactly the channels granted to them, whatever the slug (Lena: #releases)', async () => {
    expect(names(await directory(lena, 'engineering'))).toEqual([]);
    await grant(await w.channelId('engineering', 'releases'), lena.personId, 'read');
    expect(names(await directory(lena, 'engineering'))).toEqual(['releases']);
    expect(names(await directory(lena, 'anything'))).toEqual(['releases']);
  });

  it('Customer support applies once: four channels exist exactly once, however often and however concurrently it is asked', async () => {
    await Promise.all([1, 2, 3, 4, 5].map(() => w.call(sameera, 'GET', '/api/teams/customer-support/channels')));
    const rows = await w.system(async (tx) =>
      (await tx.query<{ name: string }>(
        `SELECT c.name FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'customer-support' ORDER BY c.position`,
      )).rows.map((r) => r.name),
    );
    expect(rows).toEqual(['support', 'escalations', 'enquiries', 'kb-updates']);
    const again = await w.system(async (tx) => {
      const t = await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'customer-support'");
      return (await tx.query('SELECT * FROM app.channels_sync_template($1)', [t.rows[0]!.id])).rows.length;
    });
    expect(again).toBe(0);
  });

  it('applying a template twice creates the channels once (team.template.applied consumer)', async () => {
    const first = ok<{ team: { id: string }; created: boolean }>(
      await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'customer-support', slug: 'support-two' }),
      201,
    );
    expect(first.created).toBe(true);
    const second = ok<{ created: boolean }>(await w.call(omar, 'POST', '/api/teams/from-template', { templateId: 'customer-support', slug: 'support-two' }));
    expect(second.created).toBe(false);
    // The consumer (not the directory) creates them: wait for it without asking the directory.
    const created = await waitFor(async () =>
      w.system(async (tx) =>
        (await tx.query<{ name: string }>('SELECT name FROM app.channels WHERE team_id = $1 ORDER BY position', [first.team.id])).rows.map((r) => r.name),
      ),
      (rows) => rows.length === 4,
    );
    expect(created).toEqual(['support', 'escalations', 'enquiries', 'kb-updates']);
    const events = await w.system(async (tx) =>
      (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'channel.channel.created' AND team_id = $1", [first.team.id])).rows[0]!.n,
    );
    expect(events).toBe(4);
    expect(names(await directory(omar, 'support-two'))).toEqual(['support', 'escalations', 'enquiries', 'kb-updates']);
  });
});

async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 8_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('channels: create, change, archive', () => {
  it('a team lead creates a channel (a leading # is fine); a member cannot; a duplicate name is 409', async () => {
    const created = Channel.parse(ok<{ channel: unknown }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: '#design', purpose: 'Design reviews' }), 201).channel);
    expect(created).toMatchObject({ name: 'design', private: false, kind: 'channel', purpose: 'Design reviews', archivedAt: null });
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/channels', { name: 'mine' })).status).toBe(403);
    expect((await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'design' })).status).toBe(409);
    expect((await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'Bad Name' })).status).toBe(400);
    expect((await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'x', extra: 1 })).status).toBe(400);
    expect(names(await directory(rafi, 'engineering'))).toContain('design');
    expect((await w.call(sameera, 'POST', '/api/teams/engineering/channels', { name: 'sneaky' })).status).toBe(403);
  });

  it('groups: a lead makes one, the same name again returns it, channels can move into it', async () => {
    const g1 = ok<{ group: { id: string }; created: boolean }>(await w.call(omar, 'POST', '/api/teams/engineering/channel-groups', { name: 'Product' }), 201);
    const g2 = ok<{ group: { id: string }; created: boolean }>(await w.call(omar, 'POST', '/api/teams/engineering/channel-groups', { name: 'Product' }));
    expect(g1.created).toBe(true);
    expect(g2).toMatchObject({ created: false, group: { id: g1.group.id } });
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/channel-groups', { name: 'Mine' })).status).toBe(403);
    const dev = await w.channelId('engineering', 'dev');
    const patched = ok<{ channel: { groupId: string }; changed: boolean }>(await w.call(omar, 'PATCH', `/api/channels/${dev}`, { groupId: g1.group.id }));
    expect(patched).toMatchObject({ changed: true, channel: { groupId: g1.group.id } });
    const dir = await directory(nadia, 'engineering');
    expect(dir.groups.map((g) => g.name)).toEqual(['Channels', 'Product']);
    expect(dir.groups[1]?.channels.map((c) => c.name)).toEqual(['dev']);
    expect(dir.groups[0]?.channels.map((c) => c.name)).not.toContain('dev');
    // A group of another team is refused.
    const other = ok<{ group: { id: string } }>(await w.call(tariq, 'POST', '/api/teams/marketing/channel-groups', { name: 'Other' }), 201);
    expect((await w.call(omar, 'PATCH', `/api/channels/${dev}`, { groupId: other.group.id })).status).toBe(409);
    ok(await w.call(omar, 'PATCH', `/api/channels/${dev}`, { groupId: null }));
  });

  it('rename and purpose: lead only, a no-op changes nothing, a taken name is 409, an archived channel is 409', async () => {
    const id = Channel.parse(ok<{ channel: unknown }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'scratch' }), 201).channel).id;
    expect((await w.call(nadia, 'PATCH', `/api/channels/${id}`, { purpose: 'x' })).status).toBe(403);
    expect(ok<{ changed: boolean }>(await w.call(omar, 'PATCH', `/api/channels/${id}`, { name: 'scratch' })).changed).toBe(false);
    expect((await w.call(omar, 'PATCH', `/api/channels/${id}`, { name: 'dev' })).status).toBe(409);
    expect(ok<{ channel: { name: string; purpose: string } }>(await w.call(omar, 'PATCH', `/api/channels/${id}`, { name: '#scratchpad', purpose: 'Notes' })).channel).toMatchObject({ name: 'scratchpad', purpose: 'Notes' });
    expect((await w.call(omar, 'PATCH', `/api/channels/${id}`, {})).status).toBe(400);
    expect(ok<{ changed: boolean }>(await w.call(omar, 'POST', `/api/channels/${id}/archive`)).changed).toBe(true);
    expect(ok<{ changed: boolean }>(await w.call(omar, 'POST', `/api/channels/${id}/archive`)).changed).toBe(false);
    expect((await w.call(omar, 'PATCH', `/api/channels/${id}`, { purpose: 'again' })).status).toBe(409);
    expect(names(await directory(nadia, 'engineering'))).not.toContain('scratchpad');
    expect((await post(nadia, id, 'late')).status).toBe(409);
    const detail = GetChannelResponse.parse(ok(await w.call(nadia, 'GET', `/api/channels/${id}`)));
    expect(detail).toMatchObject({ canPost: false, canManage: false });
    expect(ok<{ changed: boolean }>(await w.call(omar, 'POST', `/api/channels/${id}/unarchive`)).changed).toBe(true);
    expect((await post(nadia, id, 'back')).status).toBe(201);
  });

  it('GET /api/channels/:id says what the caller may do; hidden and missing channels are both 403', async () => {
    const dev = await w.channelId('engineering', 'dev');
    expect(GetChannelResponse.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}`)))).toMatchObject({ canPost: true, canManage: false, isMember: false });
    expect(GetChannelResponse.parse(ok(await w.call(omar, 'GET', `/api/channels/${dev}`)))).toMatchObject({ canPost: true, canManage: true });
    expect((await w.call(sameera, 'GET', `/api/channels/${dev}`)).status).toBe(403);
    expect((await w.call(sameera, 'GET', `/api/channels/${randomUUID()}`)).status).toBe(403);
    expect((await w.call(nadia, 'GET', '/api/channels/not-a-uuid')).status).toBe(400);
  });
});

describe('private channels and membership', () => {
  let leads = '';
  it('a private channel starts with its creator and is invisible to everybody else, Priya included', async () => {
    leads = Channel.parse(ok<{ channel: unknown }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'leads', private: true }), 201).channel).id;
    expect(GetChannelResponse.parse(ok(await w.call(omar, 'GET', `/api/channels/${leads}`)))).toMatchObject({ isMember: true, canPost: true, canManage: true });
    for (const who of [nadia, rafi, priya, sameera, tariq, lena]) {
      expect((await w.call(who, 'GET', `/api/channels/${leads}`)).status, who.key).toBe(403);
      expect((await post(who, leads, 'hi')).status, who.key).toBe(403);
      expect((await w.call(who, 'GET', `/api/channels/${leads}/messages`)).status, who.key).toBe(403);
    }
    expect(names(await directory(nadia, 'engineering'))).not.toContain('leads');
    const dir = await directory(omar, 'engineering');
    expect(dir.groups.flatMap((g) => g.channels).find((c) => c.name === 'leads')?.isPrivate).toBe(true);
  });

  it('a lead adds a team member (who then sees it) and removes them again; the team is the limit', async () => {
    expect(ok<{ added: boolean }>(await w.call(omar, 'POST', `/api/channels/${leads}/members`, { personId: rafi.personId })).added).toBe(true);
    expect(ok<{ added: boolean }>(await w.call(omar, 'POST', `/api/channels/${leads}/members`, { personId: rafi.personId })).added).toBe(false);
    expect((await post(rafi, leads, 'hello leads')).status).toBe(201);
    const list = ListChannelMembersResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${leads}/members`)));
    expect(list.members.map((m) => m.displayName)).toEqual(['Omar', 'Rafi']);
    expect((await w.call(nadia, 'POST', `/api/channels/${leads}/members`, { personId: nadia.personId })).status).toBe(403);
    expect((await w.call(rafi, 'POST', `/api/channels/${leads}/members`, { personId: priya.personId })).status).toBe(403);
    expect((await w.call(omar, 'POST', `/api/channels/${leads}/members`, { personId: sameera.personId })).status).toBe(409);
    expect((await w.call(omar, 'POST', `/api/channels/${leads}/members`, { personId: lena.personId })).status).toBe(409);
    expect(ok<{ removed: boolean }>(await w.call(omar, 'DELETE', `/api/channels/${leads}/members/${rafi.personId}`)).removed).toBe(true);
    expect((await w.call(rafi, 'GET', `/api/channels/${leads}`)).status).toBe(403);
    expect(ok<{ removed: boolean }>(await w.call(omar, 'DELETE', `/api/channels/${leads}/members/${rafi.personId}`)).removed).toBe(false);
    expect((await w.call(rafi, 'DELETE', `/api/channels/${leads}/members/${omar.personId}`)).status).toBe(403);
  });

  it('a workspace admin who is not on the team cannot read its private channel, and must be on the roster to be added', async () => {
    const mk = Channel.parse(ok<{ channel: unknown }>(await w.call(tariq, 'POST', '/api/teams/marketing/channels', { name: 'campaigns-private', private: true }), 201).channel).id;
    expect((await w.call(omar, 'GET', `/api/channels/${mk}`)).status).toBe(403);
    expect((await w.call(omar, 'POST', `/api/channels/${mk}/members`, { personId: omar.personId })).status).toBe(409);
    expect(names(await directory(omar, 'marketing'))).not.toContain('campaigns-private');
    // ...but a public channel of that team is readable by the admin.
    const pub = await w.channelId('marketing', (await directory(tariq, 'marketing')).groups[0]!.channels[0]!.name);
    expect((await w.call(omar, 'GET', `/api/channels/${pub}`)).status).toBe(200);
  });

  it('join and leave a public channel: members only, idempotent, never a guest or an outsider', async () => {
    const dev = await w.channelId('engineering', 'dev');
    expect(ok<{ joined: boolean }>(await w.call(priya, 'POST', `/api/channels/${dev}/join`)).joined).toBe(true);
    expect(ok<{ joined: boolean }>(await w.call(priya, 'POST', `/api/channels/${dev}/join`)).joined).toBe(false);
    expect(GetChannelResponse.parse(ok(await w.call(priya, 'GET', `/api/channels/${dev}`))).isMember).toBe(true);
    expect(ListChannelMembersResponse.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/members`))).members.map((m) => m.displayName)).toContain('Priya');
    expect(ok<{ left: boolean }>(await w.call(priya, 'POST', `/api/channels/${dev}/leave`)).left).toBe(true);
    expect(ok<{ left: boolean }>(await w.call(priya, 'POST', `/api/channels/${dev}/leave`)).left).toBe(false);
    expect((await w.call(sameera, 'POST', `/api/channels/${dev}/join`)).status).toBe(403);
    expect((await w.call(lena, 'POST', `/api/channels/${dev}/join`)).status).toBe(403);
    expect((await w.call(priya, 'POST', `/api/channels/${leads}/join`)).status).toBe(403);
  });
});

describe('messages', () => {
  let dev = '';
  let releases = '';
  beforeAll(async () => {
    dev = await w.channelId('engineering', 'dev');
    releases = await w.channelId('engineering', 'releases');
  });

  it('Nadia posts, Rafi reads it back; the body is markdown, body_plain is derived by the server', async () => {
    const sent = Message.parse(ok(await post(nadia, dev, '**Merged** `rollback` plan, see [runbook](https://x.example)'), 201));
    expect(sent).toMatchObject({ channelId: dev, authorId: nadia.actorId, threadRootId: null, editedAt: null, deletedAt: null });
    expect(sent.bodyPlain).toBe('Merged rollback plan, see runbook');
    const list = ListMessagesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages?limit=5`)));
    expect(list.items[0]?.id).toBe(sent.id);
    expect(ChannelMessage.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages/${sent.id}`))).body).toBe(sent.body);
  });

  it('who may post: Sameera and an unknown or hidden channel are 403; Lena reads with a read grant but cannot post until she has a post grant', async () => {
    expect((await post(sameera, dev, 'hi')).status).toBe(403);
    expect((await post(nadia, randomUUID(), 'hi')).status).toBe(403);
    expect((await post(null, dev, 'hi')).status).toBe(401);
    const hidden = await post(lena, releases, 'hello');
    expect(hidden.status).toBe(403);
    await grant(releases, lena.personId, 'read');
    expect((await w.call(lena, 'GET', `/api/channels/${releases}/messages`)).status).toBe(200);
    expect((await post(lena, releases, 'hello')).status).toBe(403);
    expect((await w.call(lena, 'GET', `/api/channels/${dev}/messages`)).status).toBe(403);
    expect(GetChannelResponse.parse(ok(await w.call(lena, 'GET', `/api/channels/${releases}`)))).toMatchObject({ canPost: false, canManage: false });
    expect((await w.call(lena, 'GET', `/api/channels/${releases}/members`)).status).toBe(403);
    await grant(releases, lena.personId, 'post');
    expect((await post(lena, releases, 'Thanks, team')).status).toBe(201);
    expect(GetChannelResponse.parse(ok(await w.call(lena, 'GET', `/api/channels/${releases}`))).canPost).toBe(true);
  });

  it('validates the body: empty, over 40,000 characters, wrong channel id, unknown keys', async () => {
    expect((await post(nadia, dev, '')).status).toBe(400);
    expect((await post(nadia, dev, 'x'.repeat(40_001))).status).toBe(400);
    expect((await post(nadia, dev, 'x'.repeat(40_000))).status).toBe(201);
    expect((await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: randomUUID(), body: 'x', threadRootId: null })).status).toBe(400);
    expect((await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'x', threadRootId: null, authorId: rafi.actorId })).status).toBe(400);
  });

  it('edit: only the author, sets editedAt, refreshes body_plain; delete: the author or a lead, once, and the text is gone', async () => {
    const m = Message.parse(ok(await post(nadia, dev, 'first draft'), 201));
    expect((await w.call(rafi, 'PATCH', `/api/channels/${dev}/messages/${m.id}`, { body: 'hijack' })).status).toBe(403);
    const edited = ChannelMessage.parse(ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${m.id}`, { body: '**final** draft' })));
    expect(edited).toMatchObject({ body: '**final** draft', bodyPlain: 'final draft' });
    expect(edited.editedAt).not.toBeNull();
    expect((await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${m.id}`, { body: '' })).status).toBe(400);
    expect((await w.call(rafi, 'DELETE', `/api/channels/${dev}/messages/${m.id}`)).status).toBe(403);
    expect((await w.call(sameera, 'DELETE', `/api/channels/${dev}/messages/${m.id}`)).status).toBe(403);
    expect(ok<{ deleted: boolean }>(await w.call(omar, 'DELETE', `/api/channels/${dev}/messages/${m.id}`)).deleted).toBe(true);
    expect(ok<{ deleted: boolean }>(await w.call(omar, 'DELETE', `/api/channels/${dev}/messages/${m.id}`)).deleted).toBe(false);
    expect((await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${m.id}`, { body: 'undo' })).status).toBe(409);
    const stored = await w.system(async (tx) => (await tx.query<{ body: string; body_plain: string; deleted_at: Date | null }>('SELECT body, body_plain, deleted_at FROM app.messages WHERE id = $1', [m.id])).rows[0]!);
    expect(stored.deleted_at).not.toBeNull();
    expect(stored.body_plain).toBe('');
    const served = ChannelMessage.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages/${m.id}`)));
    expect(served).toMatchObject({ bodyPlain: '', body: '[deleted]' });
    const feed = ListMessagesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages?limit=50`)));
    expect(feed.items.map((i) => i.id)).not.toContain(m.id);
    // The author deletes their own message too.
    const own = Message.parse(ok(await post(rafi, dev, 'oops'), 201));
    expect(ok<{ deleted: boolean }>(await w.call(rafi, 'DELETE', `/api/channels/${dev}/messages/${own.id}`)).deleted).toBe(true);
  });

  it('threads: a reply updates reply_count and last_reply_at in the same transaction; replies stay out of the feed', async () => {
    const root = Message.parse(ok(await post(nadia, dev, 'Deploy plan'), 201));
    const r1 = Message.parse(ok(await post(rafi, dev, 'Looks good', root.id), 201));
    const r2 = Message.parse(ok(await post(priya, dev, 'Ship it', root.id), 201));
    expect(r1.threadRootId).toBe(root.id);
    const row = await w.system(async (tx) => (await tx.query<{ reply_count: number; title: string; last_reply_at: Date }>('SELECT reply_count, title, last_reply_at FROM app.threads WHERE root_message_id = $1', [root.id])).rows[0]!);
    expect(row.reply_count).toBe(2);
    expect(row.title).toBe('Deploy plan');
    expect(row.last_reply_at.toISOString()).toBe(r2.createdAt);
    const feed = ListMessagesResponse.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/messages?limit=10`)));
    expect(feed.items.map((i) => i.id)).not.toContain(r1.id);
    expect(feed.items.find((i) => i.id === root.id)).toMatchObject({ replyCount: 2, lastReplyAt: r2.createdAt });
    const replies = ListMessagesResponse.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/messages?threadRootId=${root.id}`)));
    expect(replies.items.map((i) => i.id)).toEqual([r2.id, r1.id]);
    // Deleting a reply takes it out of the count; replying to a reply, to another channel's message or to a deleted root is refused.
    ok(await w.call(rafi, 'DELETE', `/api/channels/${dev}/messages/${r1.id}`));
    expect(ChannelMessage.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/messages/${root.id}`))).replyCount).toBe(1);
    expect((await post(nadia, dev, 'nested', r2.id)).status).toBe(409);
    expect((await post(nadia, releases, 'elsewhere', root.id)).status).toBe(404);
    expect((await post(nadia, dev, 'ghost', randomUUID())).status).toBe(404);
    const gone = Message.parse(ok(await post(nadia, dev, 'short-lived root'), 201));
    ok(await post(rafi, dev, 'a reply', gone.id), 201);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${gone.id}`));
    expect((await post(rafi, dev, 'too late', gone.id)).status).toBe(409);
    // A deleted root that holds a thread stays in the feed as a tombstone.
    expect(ListMessagesResponse.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/messages?limit=50`))).items.find((i) => i.id === gone.id)).toMatchObject({ deletedAt: expect.any(String), replyCount: 1 });
  });

  it('reactions: add, repeat, summary with mine, remove; read-only people cannot react', async () => {
    const m = Message.parse(ok(await post(nadia, dev, 'react to me'), 201));
    const path = `/api/channels/${dev}/messages/${m.id}/reactions`;
    expect(ok<{ added: boolean }>(await w.call(rafi, 'POST', path, { emoji: '👍' }), 200).added).toBe(true);
    expect(ok<{ added: boolean }>(await w.call(rafi, 'POST', path, { emoji: '👍' })).added).toBe(false);
    const both = ok<{ reactions: { emoji: string; count: number; mine: boolean }[] }>(await w.call(nadia, 'POST', path, { emoji: '👍' }));
    expect(both.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    ok(await w.call(nadia, 'POST', path, { emoji: ':tada:' }));
    const asRafi = ChannelMessage.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages/${m.id}`)));
    expect(asRafi.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }, { emoji: ':tada:', count: 1, mine: false }]);
    expect(ok<{ removed: boolean }>(await w.call(rafi, 'DELETE', `${path}/${encodeURIComponent('👍')}`)).removed).toBe(true);
    expect(ok<{ removed: boolean }>(await w.call(rafi, 'DELETE', `${path}/${encodeURIComponent('👍')}`)).removed).toBe(false);
    expect((await w.call(rafi, 'POST', path, { emoji: 'has space' })).status).toBe(400);
    expect((await w.call(sameera, 'POST', path, { emoji: '👍' })).status).toBe(403);
    // Lena has a post grant by now: take it back to read-only and she cannot react.
    const rel = Message.parse(ok(await post(nadia, releases, 'v2 is out'), 201));
    await w.system(async (tx) => {
      await tx.query("DELETE FROM app.acl_entries WHERE resource_type = 'channel' AND subject_id = $1 AND permission = 'post'", [lena.personId]);
    });
    expect((await w.call(lena, 'POST', `/api/channels/${releases}/messages/${rel.id}/reactions`, { emoji: '👍' })).status).toBe(403);
    expect((await w.call(lena, 'GET', `/api/channels/${releases}/messages/${rel.id}`)).status).toBe(200);
  });

  it('paginates 5,000 messages newest first with no gaps and no repeats', async () => {
    const id = Channel.parse(ok<{ channel: unknown }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'busy' }), 201).channel).id;
    await w.system(async (tx) => {
      await tx.query(
        `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain)
         SELECT $1, $2, $3, 'message ' || n, 'message ' || n FROM generate_series(1, 5000) n`,
        [nadia.workspaceId, id, nadia.actorId],
      );
    });
    const expected = await w.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.messages WHERE channel_id = $1 ORDER BY id DESC', [id])).rows.map((r) => r.id));
    expect(expected).toHaveLength(5000);
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    for (;;) {
      const qs: string = `limit=200${before ? `&before=${before}` : ''}`;
      const page: ListMessagesResponseType = ListMessagesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${id}/messages?${qs}`)));
      pages += 1;
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      expect(page.items).toHaveLength(200);
      expect(page.nextCursor).toBe(page.items[199]?.id);
      before = page.nextCursor;
    }
    expect(pages).toBe(25);
    expect(seen).toEqual(expected);
    const odd = ListMessagesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${id}/messages?limit=7`)));
    expect(odd.items).toHaveLength(7);
    expect((await w.call(rafi, 'GET', `/api/channels/${id}/messages?limit=0`)).status).toBe(400);
    expect((await w.call(rafi, 'GET', `/api/channels/${id}/messages?limit=201`)).status).toBe(400);
    expect((await w.call(rafi, 'GET', `/api/channels/${id}/messages?before=nope`)).status).toBe(400);
  }, 120_000);
});
