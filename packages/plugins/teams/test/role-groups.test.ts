import { randomUUID } from 'node:crypto';
import { withActor, type Actor } from '@manythreads/kernel';
import type { PluginTx, RoleGroupProvider } from '@manythreads/sdk';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

// The `role.groups` provider (P14-03): the one definition of who a role tag means, as another plugin asks it.
const { omar, nadia, rafi, sameera } = personas;
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let w: World;
let provider: RoleGroupProvider;
let bot: Actor;
const TEAM = TEAM_IDS.Engineering;
const tagPath = (personId: string, tag: string): string => `/api/teams/engineering/members/${personId}/tags/${encodeURIComponent(tag)}`;

const asPerson = <T>(p: { actorId: string; workspaceId: string }, fn: (tx: PluginTx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId } as unknown as Actor, (tx) => fn(tx as unknown as PluginTx), { pool: w.server.pools.app });

beforeAll(async () => {
  w = await createWorld();
  const found = w.server.host.registries.providers['role.groups'].values()[0];
  if (!found) throw new Error('the teams plugin did not register role.groups');
  provider = found as RoleGroupProvider;
  expect((await w.call(omar, 'POST', '/api/teams/engineering/tags', { name: 'role:pager' })).status).toBe(201);
  expect((await w.call(omar, 'PUT', tagPath(rafi.personId, 'role:pager'))).status).toBe(200);
  const slug = `scout-${randomUUID().slice(0, 4)}`;
  const actorId = await w.system(async (tx) => {
    const b = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[]'::jsonb, ARRAY['smart']) RETURNING id`,
      [omar.workspaceId, TEAM, slug],
    );
    const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, b.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM, a.rows[0]!.id, omar.workspaceId]);
    return a.rows[0]!.id;
  });
  bot = { kind: 'bot', id: actorId, workspaceId: omar.workspaceId } as unknown as Actor;
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('the role groups of a team', () => {
  it('a team member (a person) gets the groups with their holders', async () => {
    const groups = await asPerson(nadia, (tx) => provider.list(tx, TEAM));
    expect(groups).toEqual([{ tag: 'role:pager', handle: 'pager', personIds: [rafi.personId], mentionable: true, closedBy: null }]);
  });

  it('a bot of the team gets the same groups: the roles table is hidden from bots, the roster is not', async () => {
    const groups = await withActor(bot, (tx) => provider.list(tx as unknown as PluginTx, TEAM), { pool: w.server.pools.app });
    expect(groups.map((g) => [g.tag, g.personIds])).toEqual([['role:pager', [rafi.personId]]]);
  });

  it('someone who cannot read the team gets nothing, as for a team with no tags', async () => {
    expect(await asPerson(sameera, (tx) => provider.list(tx, TEAM))).toEqual([]);
  });

  it('a team with no role tag is answered without reading the roster', async () => {
    const queries: string[] = [];
    const answer = await asPerson(nadia, (tx) => provider.list({ actor: tx.actor, query: (t, v) => (queries.push(t), tx.query(t, v)) } as PluginTx, TEAM_IDS['Marketing']));
    expect(answer).toEqual([]);
    expect(queries.some((q) => q.includes('teams_roster'))).toBe(false);
  });

  it('when every handle asked for is a bot of the team, the roster is not read either', async () => {
    const slug = (await w.system(async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.bots WHERE team_id = $1 LIMIT 1', [TEAM])).rows[0]!.slug));
    const queries: string[] = [];
    const answer = await asPerson(nadia, (tx) => provider.list({ actor: tx.actor, query: (t, v) => (queries.push(t), tx.query(t, v)) } as PluginTx, TEAM, { handles: [slug] }));
    expect(answer).toEqual([]);
    expect(queries.some((q) => q.includes('teams_roster'))).toBe(false);
    // another handle in the list reads it as usual
    expect((await asPerson(nadia, (tx) => provider.list(tx, TEAM, { handles: [slug, 'pager'] }))).map((g) => g.handle)).toEqual(['pager']);
  });
});
