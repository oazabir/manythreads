import { NavChannelDirectory, SidebarPrefs, MAX_STARRED_CHANNELS } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type World } from './world.ts';

const { omar, nadia, rafi, sameera, lena, priya } = personas;

let w: World;
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const get = (who: typeof nadia | null, slug = 'engineering'): Promise<ApiResult> => w.call(who, 'GET', `/api/teams/${slug}/sidebar-prefs`);
const put = (who: typeof nadia | null, body: unknown, slug = 'engineering'): Promise<ApiResult> => w.call(who, 'PUT', `/api/teams/${slug}/sidebar-prefs`, body);
// the stars come back in a fixed order (the clients sort them), so a test compares them sorted
const prefs = (res: ApiResult): SidebarPrefs => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const p = SidebarPrefs.parse(res.body);
  return { ...p, starred: [...p.starred].sort() };
};
const sorted = (...ids: string[]): string[] => [...ids].sort();

describe('sidebar preferences (GET and PUT /api/teams/:slug/sidebar-prefs)', () => {
  it('starts with the defaults and keeps what a person saves, separately for each person', async () => {
    // the team's own order is the default: nothing changes for a person who never opened the options
    expect(prefs(await get(nadia))).toEqual({ starred: [], sort: 'team', hideIdle: false, groupOrder: [] });
    const dev = await w.channelId('engineering', 'dev');
    const general = await w.channelId('engineering', 'general');
    expect(prefs(await put(nadia, { starAdd: [dev, general] })).starred).toEqual(sorted(dev, general));
    expect(prefs(await put(nadia, { sort: 'name', hideIdle: true }))).toMatchObject({ starred: sorted(dev, general), sort: 'name', hideIdle: true });
    expect(prefs(await put(nadia, { sort: 'recent' })).sort).toBe('recent');
    expect(prefs(await put(nadia, { sort: 'team' })).sort).toBe('team');
    expect(prefs(await get(nadia))).toMatchObject({ starred: sorted(dev, general), sort: 'team', hideIdle: true });
    expect(prefs(await get(rafi))).toEqual({ starred: [], sort: 'team', hideIdle: false, groupOrder: [] });
    expect(prefs(await put(nadia, { starRemove: [dev] })).starred).toEqual([general]);
    // removing a channel that is not starred, or starring one that already is, changes nothing and is not an error
    expect(prefs(await put(nadia, { starRemove: [dev], starAdd: [general] })).starred).toEqual([general]);
    expect(prefs(await put(nadia, { starRemove: [general] })).starred).toEqual([]);
  });

  it('stars are changes, not a whole list: two devices that starred different channels both keep their star', async () => {
    const dev = await w.channelId('engineering', 'dev');
    const general = await w.channelId('engineering', 'general');
    // both devices loaded an empty list; each one adds its own channel
    await Promise.all([put(rafi, { starAdd: [dev] }), put(rafi, { starAdd: [general] })].map((p) => p.then((r) => expect(r.status).toBe(200))));
    expect(prefs(await get(rafi)).starred).toEqual(sorted(dev, general));
    // a device that only unstars one leaves the other alone
    expect(prefs(await put(rafi, { starRemove: [dev] })).starred).toEqual([general]);
    expect(prefs(await put(rafi, { starRemove: [general] })).starred).toEqual([]);
  });

  it('keeps the order of the groups, only of groups of the team, each once', async () => {
    const dir = NavChannelDirectory.parse((await w.call(rafi, 'GET', '/api/teams/engineering/channels')).body);
    const teamEntry = dir.groups[0]!.id;
    const group = await w.call<{ group: { id: string } }>(omar, 'POST', '/api/teams/engineering/channel-groups', { name: 'Projects' });
    const groupId = group.body.group.id;
    expect(prefs(await put(rafi, { groupOrder: [groupId, teamEntry] })).groupOrder).toEqual([groupId, teamEntry]);
    expect(prefs(await get(rafi)).groupOrder).toEqual([groupId, teamEntry]);
    expect((await put(rafi, { groupOrder: [groupId, groupId] })).status).toBe(400);
    expect((await put(rafi, { groupOrder: ['0198a7b0-0000-7000-8000-000000000001'] })).status).toBe(400);
    // a group of another team is not one of this team's groups
    const other = await w.call<{ group: { id: string } }>(personas.tariq, 'POST', '/api/teams/marketing/channel-groups', { name: 'Campaigns' });
    expect((await put(rafi, { groupOrder: [other.body.group.id] })).status).toBe(400);
    expect(prefs(await put(rafi, { groupOrder: [] })).groupOrder).toEqual([]);
  });

  it('refuses what it should: nothing to change, unknown fields, a channel the person cannot see, a direct message, another team, too many stars', async () => {
    expect((await put(nadia, {})).status).toBe(400);
    expect((await put(nadia, { colour: 'red' })).status).toBe(400);
    expect((await put(nadia, { sort: 'size' })).status).toBe(400);
    const support = await w.channelId('customer-support', 'support');
    // Nadia is not on Customer support: the channel looks as if it did not exist (403), and the team's own prefs are not hers either
    expect((await put(nadia, { starAdd: [support] })).status).toBe(403);
    expect((await get(nadia, 'customer-support')).status).toBe(403);
    // a channel of another team that the person can see is the wrong team for this list
    const dev = await w.channelId('engineering', 'dev');
    expect((await put(omar, { starAdd: [dev] }, 'marketing')).status).toBe(400);
    expect((await put(nadia, { starAdd: [randomId()] })).status).toBe(403);
    const tooMany = Array.from({ length: MAX_STARRED_CHANNELS + 1 }, () => randomId());
    expect((await put(nadia, { starAdd: tooMany })).status).toBe(400);
    expect((await put(nadia, { starred: [dev] })).status).toBe(400);
    expect((await put(nadia, { starAdd: [dev], starRemove: [dev] })).status).toBe(400);
    expect((await get(null)).status).toBe(401);
    expect(prefs(await get(nadia)).starred).toEqual([]);
  });

  it('does not let a person star a private channel they are not in, and drops a star when they lose the channel', async () => {
    const leads = await w.system(async (tx) => {
      const team = (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id;
      const row = await tx.query<{ id: string }>(
        `INSERT INTO app.channels (workspace_id, team_id, name, private) VALUES ($1, $2, 'star-private', true) RETURNING id`,
        [omar.workspaceId, team],
      );
      await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [row.rows[0]!.id, rafi.personId]);
      return row.rows[0]!.id;
    });
    expect((await put(nadia, { starAdd: [leads] })).status).toBe(403);
    expect(prefs(await put(rafi, { starAdd: [leads] })).starred).toEqual([leads]);
    await w.system((tx) => tx.query('DELETE FROM app.channel_members WHERE channel_id = $1 AND person_id = $2', [leads, rafi.personId]));
    // the row is still there, but a person who can no longer read the channel is not shown it
    expect(prefs(await get(rafi)).starred).toEqual([]);
  });

  it('keeps at most 100 stars per team, counting the stars that stay, and a full list can still swap one star for another', async () => {
    const team = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
    const made = await w.system(async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < MAX_STARRED_CHANNELS + 1; i++) {
        const r = await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, name) VALUES ($1, $2, $3) RETURNING id`, [omar.workspaceId, team, `star-cap-${i}`]);
        ids.push(r.rows[0]!.id);
      }
      return ids;
    });
    const first = made.slice(0, MAX_STARRED_CHANNELS);
    expect(prefs(await put(priya, { starAdd: first })).starred).toHaveLength(MAX_STARRED_CHANNELS);
    expect((await put(priya, { starAdd: [made[MAX_STARRED_CHANNELS]!] })).status).toBe(400);
    expect(prefs(await get(priya)).starred).toHaveLength(MAX_STARRED_CHANNELS);
    // one out and one in in the same change keeps the count at the cap
    const swapped = prefs(await put(priya, { starRemove: [first[0]!], starAdd: [made[MAX_STARRED_CHANNELS]!] })).starred;
    expect(swapped).toHaveLength(MAX_STARRED_CHANNELS);
    expect(swapped).toContain(made[MAX_STARRED_CHANNELS]);
    expect(swapped).not.toContain(first[0]);
  });

  it('a guest has no team to arrange, and a stale star of an archived channel is not listed', async () => {
    expect((await get(lena)).status).toBe(403);
    expect((await put(lena, { sort: 'name' })).status).toBe(403);
    const standup = await w.channelId('engineering', 'standup');
    expect(prefs(await put(omar, { starAdd: [standup] })).starred).toEqual([standup]);
    await w.call(omar, 'POST', `/api/channels/${standup}/archive`);
    expect(prefs(await get(omar)).starred).toEqual([]);
    expect(prefs(await get(sameera, 'customer-support')).starred).toEqual([]);
  });

  it('the directory says when each channel last had a message (when it was made, if none)', async () => {
    const dev = await w.channelId('engineering', 'dev');
    const before = NavChannelDirectory.parse((await w.call(nadia, 'GET', '/api/teams/engineering/channels')).body);
    const devBefore = before.groups.flatMap((g) => g.channels).find((c) => c.id === dev)!;
    expect(Date.parse(devBefore.lastActivityAt!)).toBeGreaterThan(0);
    const posted = await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'activity', threadRootId: null });
    expect(posted.status).toBe(201);
    const after = NavChannelDirectory.parse((await w.call(nadia, 'GET', '/api/teams/engineering/channels')).body);
    const devAfter = after.groups.flatMap((g) => g.channels).find((c) => c.id === dev)!;
    expect(Date.parse(devAfter.lastActivityAt!)).toBeGreaterThan(Date.parse(devBefore.lastActivityAt!));
    // a deleted message no longer counts as activity
    const posted2 = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'gone soon', threadRootId: null });
    expect(posted2.status).toBe(201);
    const afterSecond = NavChannelDirectory.parse((await w.call(nadia, 'GET', '/api/teams/engineering/channels')).body).groups.flatMap((g) => g.channels).find((c) => c.id === dev)!;
    expect(Date.parse(afterSecond.lastActivityAt!)).toBeGreaterThan(Date.parse(devAfter.lastActivityAt!));
    await w.system((tx) => tx.query('UPDATE app.messages SET deleted_at = now() WHERE id = $1', [posted2.body.id]));
    const afterDelete = NavChannelDirectory.parse((await w.call(nadia, 'GET', '/api/teams/engineering/channels')).body).groups.flatMap((g) => g.channels).find((c) => c.id === dev)!;
    expect(afterDelete.lastActivityAt).toBe(devAfter.lastActivityAt);
  });
});

const randomId = (): string => crypto.randomUUID();
