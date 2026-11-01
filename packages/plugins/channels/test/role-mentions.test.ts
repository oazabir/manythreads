import { randomUUID } from 'node:crypto';
import { withActor, withSystem, type Actor } from '@manythreads/kernel';
import type { MessageProvider, PluginTx } from '@manythreads/sdk';
import { ListMentionGroupsResponse } from '@manythreads/shared';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mentionBudget } from '../src/mention-budget.ts';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from './world.ts';

// P14-03: a role tag a team defines (`role:pager`) is also a mention handle (`@pager`) for the team members who hold it.
const { omar, nadia, rafi, priya, sameera, lena } = personas;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let w: World;
let dev = '';
let releases = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  releases = await w.channelId('engineering', 'releases');
  // Omar leads Engineering. `pager`: Rafi, Priya and Omar hold it. `quiet`: nobody. `nadia`: a tag named like a person.
  for (const tag of ['role:pager', 'role:quiet', 'role:nadia']) ok(await w.call(omar, 'POST', '/api/teams/engineering/tags', { name: tag }), 201);
  // `all` is a reserved word, which can no longer be defined; a team that had it before is simulated by defining it as the system.
  await w.system((tx) => tx.query('SELECT * FROM app.teams_tag_define($1, $2)', [TEAM_IDS.Engineering, 'role:all']));
  for (const [who, tag] of [[rafi, 'role:pager'], [priya, 'role:pager'], [omar, 'role:pager'], [rafi, 'role:nadia']] as const) {
    ok(await w.call(omar, 'PUT', `/api/teams/engineering/members/${who.personId}/tags/${encodeURIComponent(tag)}`));
  }
  await w.system((tx) => tx.query(`SELECT app.teams_tag_assign($1, $2, 'role:all')`, [TEAM_IDS.Engineering, rafi.personId]));
}, 180_000);
beforeEach(() => mentionBudget.reset());
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const post = async (who: Persona, channelId: string, body: string): Promise<string> =>
  ok(await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;
const edit = async (who: Persona, channelId: string, id: string, body: string): Promise<void> => {
  ok(await w.call(who, 'PATCH', `/api/channels/${channelId}/messages/${id}`, { body }));
};
const mentioned = (messageId: string): Promise<string[]> =>
  w.system(async (tx) => (await tx.query<{ mentioned_id: string }>("SELECT mentioned_id FROM app.message_mentions WHERE message_id = $1 AND kind = 'person'", [messageId])).rows.map((r) => r.mentioned_id).sort());
const announced = (messageId: string): Promise<string[]> =>
  w.system(async (tx) => (await tx.query<{ id: string }>("SELECT payload->>'mentionedId' AS id FROM app.events WHERE type = 'channel.mention.created' AND payload->>'messageId' = $1", [messageId])).rows.map((r) => r.id).sort());
const sorted = (...p: Persona[]): string[] => p.map((x) => x.actorId).sort();
const groups = async (who: Persona, channelId: string) => ListMentionGroupsResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/mention-groups`))).groups;

describe('a role tag is a mention handle', () => {
  it('@pager names the team members who hold the tag, not the author, and announces each once', async () => {
    const id = await post(nadia, dev, 'Pager please: the deploy is stuck @pager');
    expect(await mentioned(id)).toEqual(sorted(rafi, priya, omar));
    expect(await announced(id)).toEqual(sorted(rafi, priya, omar));
  });

  it('the author holding the tag is left out', async () => {
    const id = await post(omar, dev, 'Whoever is on the @pager, a look please');
    expect(await mentioned(id)).toEqual(sorted(rafi, priya));
  });

  it('a person named directly and through the group is named and announced once', async () => {
    const id = await post(nadia, dev, '@rafi first, then everyone on @pager. @Pager again');
    expect(await mentioned(id)).toEqual(sorted(rafi, priya, omar));
    expect(await announced(id)).toEqual(sorted(rafi, priya, omar));
  });

  it('a group nobody holds, and a handle that is no tag, name nobody', async () => {
    const id = await post(nadia, dev, '@quiet @no-such-group');
    expect(await mentioned(id)).toEqual([]);
    expect(await announced(id)).toEqual([]);
  });

  it('a person wins over a tag with the same word: @nadia is still Nadia, and the tag is not a group', async () => {
    const id = await post(rafi, dev, 'ping @nadia');
    expect(await mentioned(id)).toEqual(sorted(nadia));
    expect((await groups(omar, dev)).map((g) => g.handle)).not.toContain('nadia');
  });

  it('a reserved word is never a group, even when a team defines the tag', async () => {
    const id = await post(nadia, dev, '@all');
    expect(await mentioned(id)).toEqual([]);
    expect((await groups(omar, dev)).map((g) => g.handle)).not.toContain('all');
  });

  it('code spans, fences and addresses do not mention a group', async () => {
    const id = await post(nadia, dev, 'use `@pager` or\n```\n@pager\n```\nor mail x@pager.example');
    expect(await mentioned(id)).toEqual([]);
  });

  it('only holders who can read the channel are named: a private channel leaves out team members who are not in it', async () => {
    const priv = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'pager-private', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: rafi.personId }));
    const id = await post(omar, priv, '@pager');
    expect(await mentioned(id)).toEqual(sorted(rafi));      // Priya holds the tag but is not in the channel; Omar is the author
    expect(await announced(id)).toEqual(sorted(rafi));
    // the picker's number is the same: Omar (author, counted) and Rafi
    expect(await groups(omar, priv)).toEqual([{ handle: 'pager', tag: 'role:pager', memberCount: 2 }]);
    // someone who cannot read the channel learns nothing from it
    expect((await w.call(priya, 'GET', `/api/channels/${priv}/mention-groups`)).status).toBe(403);
  });

  it('a direct message has no team and so no groups', async () => {
    const dm = ok(await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [rafi.personId, priya.personId] }), 201).dm.channel.id;
    const id = await post(nadia, dm, '@pager');
    expect(await mentioned(id)).toEqual([]);
    expect(await groups(nadia, dm)).toEqual([]);
  });

  it('an edit keeps its rows: it adds rows and announcements only for a group it newly names, and a member who joined the tag since is not added', async () => {
    const id = await post(priya, dev, 'first draft');
    await edit(priya, dev, id, 'first draft, cc @pager');
    expect(await announced(id)).toEqual(sorted(rafi, omar));
    ok(await w.call(omar, 'PUT', `/api/teams/engineering/members/${nadia.personId}/tags/${encodeURIComponent('role:pager')}`));
    await edit(priya, dev, id, 'second draft, cc @pager');
    expect(await mentioned(id)).toEqual(sorted(rafi, omar));                 // Nadia joined after the first mention: neither recorded nor pinged by a wording change
    expect(await announced(id)).toEqual(sorted(rafi, omar));
    ok(await w.call(omar, 'DELETE', `/api/teams/engineering/members/${nadia.personId}/tags/${encodeURIComponent('role:pager')}`));
  });

  it('a person who left the tag keeps the row while the handle stays in the text; deleting the handle removes the rows of the people who still hold it', async () => {
    const id = await post(priya, dev, 'cc @pager');
    expect(await mentioned(id)).toEqual(sorted(rafi, omar));
    ok(await w.call(omar, 'DELETE', `/api/teams/engineering/members/${rafi.personId}/tags/${encodeURIComponent('role:pager')}`));
    await edit(priya, dev, id, 'cc @pager, thanks');
    expect(await mentioned(id)).toEqual(sorted(rafi, omar));                 // Rafi left the tag: his row is kept, not removed by a wording change
    await edit(priya, dev, id, 'no pings any more');
    expect(await mentioned(id)).toEqual(sorted(rafi));                       // Omar still holds the tag so his row goes; Rafi, who left, cannot be told apart from an older row and stays
    ok(await w.call(omar, 'PUT', `/api/teams/engineering/members/${rafi.personId}/tags/${encodeURIComponent('role:pager')}`));
  });

  it('a direct @person who is removed from the text loses the row even while a group stays', async () => {
    const id = await post(priya, dev, '@nadia please, and @pager');
    expect(await mentioned(id)).toEqual(sorted(nadia, rafi, omar));
    await edit(priya, dev, id, 'and @pager');
    expect(await mentioned(id)).toEqual(sorted(rafi, omar));
  });

  it('a thread reply names a group the same as a channel message', async () => {
    const root = await post(nadia, dev, 'a thread about the deploy');
    const reply = ok(await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'paging @pager here', threadRootId: root }), 201).id;
    expect(await mentioned(reply)).toEqual(sorted(rafi, priya, omar));
    expect(await announced(reply)).toEqual(sorted(rafi, priya, omar));
  });
});

describe('the groups the picker lists', () => {
  it('lists each group with the number of readers who hold it, alphabetically, and leaves out empty, person-named and reserved ones', async () => {
    expect(await groups(nadia, dev)).toEqual([{ handle: 'pager', tag: 'role:pager', memberCount: 3 }]);
  });

  it('a member of another team cannot read the channel, so cannot ask (403, the same as for any channel they cannot see)', async () => {
    expect((await w.call(sameera, 'GET', `/api/channels/${dev}/mention-groups`)).status).toBe(403);
  });

  it('a guest the channel has not been granted to is refused, so learns nothing', async () => {
    expect((await w.call(lena, 'GET', `/api/channels/${releases}/mention-groups`)).status).toBe(403);
  });

  it('a guest who may read the channel gets an empty list and never learns who holds a tag', async () => {
    await w.system((tx) =>
      tx.query(`INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'channel', $2, 'person', $3, 'read')`, [lena.workspaceId, releases, lena.personId]),
    );
    const res = await w.call(lena, 'GET', `/api/channels/${releases}/mention-groups`);
    expect(ListMentionGroupsResponse.parse(ok(res)).groups).toEqual([]);
  });

  it('a request with no actor is refused', async () => {
    expect((await w.call(null, 'GET', `/api/channels/${dev}/mention-groups`)).status).toBe(401);
  });
});

describe('tags and the words they may take', () => {
  const tagList = async (): Promise<Array<{ name: string; mentionable?: boolean; closedBy?: string | null }>> =>
    ok(await w.call<{ tags: Array<{ name: string; mentionable?: boolean; closedBy?: string | null }> }>(omar, 'GET', '/api/teams/engineering/tags')).tags;
  const closedEvents = (tag: string): Promise<string[]> =>
    w.system(async (tx) => (await tx.query<{ reason: string }>("SELECT payload->>'reason' AS reason FROM app.events WHERE type = 'team.tag.handle_closed' AND payload->>'tag' = $1", [tag])).rows.map((r) => r.reason));
  const setPerson = (p: Persona, fields: { name?: string; email?: string }) =>
    w.system((tx) => tx.query('UPDATE app.people SET display_name = coalesce($2, display_name), primary_email = coalesce($3, primary_email) WHERE id = $1', [p.personId, fields.name ?? null, fields.email ?? null]));

  it('refuses a reserved word with a plain sentence, whether the tag is defined or first given to someone', async () => {
    for (const word of ['admin', 'owners', 'here', 'team', 'everybody', 'security', 'mods']) {
      const made = await w.call<{ error: { message: string } }>(omar, 'POST', '/api/teams/engineering/tags', { name: `role:${word}` });
      expect(made.status, word).toBe(400);
      expect(made.body.error.message, word).toContain(`"${word}" is kept for`);
      expect((await w.call(omar, 'PUT', `/api/teams/engineering/members/${rafi.personId}/tags/${encodeURIComponent(`role:${word}`)}`)).status, word).toBe(400);
    }
  });

  it('lists each tag with whether @word is open, and why not when a person, a bot or a reserved word has it; the audit row is written once, when the tag is defined', async () => {
    const tags = await tagList();
    expect(tags.find((t) => t.name === 'role:pager')).toMatchObject({ mentionable: true, closedBy: null });
    expect(tags.find((t) => t.name === 'role:nadia')).toMatchObject({ mentionable: false, closedBy: 'person' });
    expect(tags.find((t) => t.name === 'role:all')).toMatchObject({ mentionable: false, closedBy: 'reserved' });
    expect(await closedEvents('role:nadia')).toEqual(['person']);
    expect(await closedEvents('role:pager')).toEqual([]);
  });

  it('a bot with the slug closes the tag', async () => {
    const slug = `helper-${randomUUID().slice(0, 4)}`;
    ok(await w.call(omar, 'POST', '/api/teams/engineering/tags', { name: `role:${slug}` }), 201);
    await w.system(async (tx) => {
      const bot = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
         VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[]'::jsonb, ARRAY['smart']) RETURNING id`,
        [omar.workspaceId, TEAM_IDS.Engineering, slug],
      );
      await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2)", [omar.workspaceId, bot.rows[0]!.id]);
    });
    expect((await tagList()).find((t) => t.name === `role:${slug}`)).toMatchObject({ mentionable: false, closedBy: 'bot' });
  });

  it('a first name does not close a tag: only the email part and the name as a slug do', async () => {
    await setPerson(sameera, {});
    await setPerson(rafi, { name: 'Rafi Khan', email: 'rafi.k@kahf.example' });
    try {
      ok(await w.call(omar, 'POST', '/api/teams/engineering/tags', { name: 'role:rafi' }), 201);
      ok(await w.call(omar, 'PUT', `/api/teams/engineering/members/${priya.personId}/tags/${encodeURIComponent('role:rafi')}`));
      expect((await tagList()).find((t) => t.name === 'role:rafi')).toMatchObject({ mentionable: true, closedBy: null });
      // `@rafi` is the first name of Rafi Khan, but the team's tag has the word, so it names the tag's holders
      const id = await post(nadia, dev, 'ping @rafi');
      expect(await mentioned(id)).toEqual(sorted(priya));
      // the exact handles still reach the person
      const exact = await post(nadia, dev, 'ping @rafi.k and @rafi-khan');
      expect(await mentioned(exact)).toEqual(sorted(rafi));
    } finally {
      await setPerson(rafi, { name: 'Rafi', email: 'rafi@kahf.example' });
    }
  });

  it('a rename after the tag was defined closes it: the list says why and @word means the person from then on', async () => {
    ok(await w.call(omar, 'POST', '/api/teams/engineering/tags', { name: 'role:newbie' }), 201);
    ok(await w.call(omar, 'PUT', `/api/teams/engineering/members/${rafi.personId}/tags/${encodeURIComponent('role:newbie')}`));
    const before = await post(nadia, dev, '@newbie');
    expect(await mentioned(before)).toEqual(sorted(rafi));
    await setPerson(priya, { name: 'Newbie' });
    try {
      expect((await tagList()).find((t) => t.name === 'role:newbie')).toMatchObject({ mentionable: false, closedBy: 'person' });
      expect((await groups(nadia, dev)).map((g) => g.handle)).not.toContain('newbie');
      const after = await post(nadia, dev, '@newbie');
      expect(await mentioned(after)).toEqual(sorted(priya));
    } finally {
      await setPerson(priya, { name: 'Priya' });
    }
  });
});

describe('the group mention budget', () => {
  it('refuses the sixth group mention within a minute with a plain sentence and posts nothing', async () => {
    for (let i = 0; i < 5; i++) await post(nadia, dev, `page ${i} @pager`);
    const count = (): Promise<number> => w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.messages WHERE channel_id = $1", [dev])).rows[0]!.n);
    const before = await count();
    const refused = await w.call<{ error: { code: string; message: string } }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'one more @pager', threadRootId: null });
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toBe('You used group mentions (a group, @channel or @here) too often: 5 a minute at most. Try again in a minute.');
    expect(await count()).toBe(before);
    // a message without a group is not affected, and neither is another author
    await post(nadia, dev, 'no group here');
    expect(await mentioned(await post(priya, dev, 'priya pages @pager'))).toEqual(sorted(rafi, omar));
  });

  it('an edit that adds a group is charged too; one that keeps the same group is not', async () => {
    for (let i = 0; i < 4; i++) await post(nadia, dev, `page ${i} @pager`);
    const id = await post(nadia, dev, 'draft');
    await edit(nadia, dev, id, 'draft @pager');                              // the fifth
    const again = await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'draft @pager, more words' });
    expect(again.status).toBe(200);                                          // the same group again: free
    const other = await post(nadia, dev, 'another');
    expect((await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${other}`, { body: 'another @pager' })).status).toBe(429);
  });
});

describe('a big group', () => {
  it('notifies the first 500 per group, tells the author, counts everyone in the picker, and writes the events in a few statements', async () => {
    // 520 more holders of `role:crowd`, as team members of Engineering (direct inserts: the invitation flow is not under test)
    await w.system(async (tx) => {
      await tx.query(`SELECT * FROM app.teams_tag_define($1, 'role:crowd')`, [TEAM_IDS.Engineering]);
      const ws = omar.workspaceId;
      await tx.query(`CREATE TEMP TABLE crowd_ids AS SELECT gen_random_uuid() AS pid, gen_random_uuid() AS aid, g FROM generate_series(1, 520) g`);
      await tx.query(`INSERT INTO app.people (id, workspace_id, display_name, primary_email) SELECT pid, $1, 'Crowd ' || g, 'crowd' || g || '@crowd.example' FROM crowd_ids`, [ws]);
      await tx.query(`INSERT INTO app.actors (id, kind, workspace_id, ref_id) SELECT aid, 'person', $1, pid FROM crowd_ids`, [ws]);
      await tx.query(`INSERT INTO app.workspace_members (workspace_id, person_id, role) SELECT $1, pid, 'member' FROM crowd_ids`, [ws]);
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT $2, aid, $1, 'member' FROM crowd_ids`, [ws, TEAM_IDS.Engineering]);
      await tx.query(
        `INSERT INTO app.role_members (role_id, person_id, workspace_id)
         SELECT (SELECT r.id FROM app.roles r JOIN app.team_role_tags trt ON trt.role_id = r.id WHERE trt.team_id = $2 AND r.name = 'role:crowd'), pid, $1 FROM crowd_ids`,
        [ws, TEAM_IDS.Engineering],
      );
    });
    const crowd = (await groups(nadia, dev)).find((g) => g.handle === 'crowd');
    expect(crowd?.memberCount).toBe(520);                                    // the picker counts everyone who can read, not the cap
    const started = Date.now();
    const res = ok(await w.call<{ id: string; groupNotices?: Array<{ handle: string; reached: number; notified: number }> }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'everyone on @crowd', threadRootId: null }), 201);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(res.groupNotices).toEqual([{ handle: 'crowd', reached: 520, notified: 500 }]);
    expect((await mentioned(res.id)).length).toBe(500);
    expect((await announced(res.id)).length).toBe(500);
    // the 500 people reached count against the hour: a second one is refused (1,000 per hour)
    await post(nadia, dev, 'again @crowd');
    const third = await w.call<{ error: { message: string } }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'and again @crowd', threadRootId: null });
    expect(third.status).toBe(429);
    expect(third.body.error.message).toBe('Your group mentions (a group, @channel or @here) have reached 1,000 people this hour, the most allowed. Try again later.');
  });
});

describe('who posts', () => {
  let provider: MessageProvider;
  beforeAll(() => {
    const found = w.server.host.registries.providers.messages.values()[0];
    if (!found) throw new Error('the channels plugin did not register the messages provider');
    provider = found as MessageProvider;
  });
  const asBot = async (): Promise<Actor> => {
    const slug = `poster-${randomUUID().slice(0, 4)}`;
    const actorId = await w.system(async (tx) => {
      const bot = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
         VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[]'::jsonb, ARRAY['smart']) RETURNING id`,
        [omar.workspaceId, TEAM_IDS.Engineering, slug],
      );
      const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot.rows[0]!.id]);
      await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actor.rows[0]!.id, omar.workspaceId]);
      return actor.rows[0]!.id;
    });
    return { kind: 'bot', id: actorId, workspaceId: omar.workspaceId } as unknown as Actor;
  };

  it('a message a bot writes reaches no group: bots resolve nobody, as for @person', async () => {
    const bot = await asBot();
    const posted = await withActor(bot, (tx) => provider.post(tx as unknown as PluginTx, { channelId: dev, body: 'paging @pager and @rafi' }), { pool: w.server.pools.app });
    expect(await mentioned(posted.id)).toEqual([]);
    expect(await announced(posted.id)).toEqual([]);
  });

  it('a message the server posts in the system role under an actor of its own reaches the group, with a budget per actor', async () => {
    const author = await asBot();
    const send = (text: string) =>
      withSystem(
        async (tx) => {
          await tx.query("SELECT set_config('app.actor_id', $1, true)", [author.id]);
          const asServer: PluginTx = { actor: { kind: 'system', id: author.id, workspaceId: omar.workspaceId }, query: (t, v) => tx.query(t, v) };
          return provider.post(asServer, { channelId: dev, body: text });
        },
        { pool: w.server.pools.system, workspaceId: omar.workspaceId },
      );
    const first = await send('notice 0: @pager');
    expect(await mentioned(first.id)).toEqual(sorted(rafi, priya, omar));
    expect(await announced(first.id)).toEqual(sorted(rafi, priya, omar));
    for (let i = 1; i < 5; i++) await send(`notice ${i}: @pager`);
    await expect(send('notice 5: @pager')).rejects.toMatchObject({ status: 429 });
  });
});
