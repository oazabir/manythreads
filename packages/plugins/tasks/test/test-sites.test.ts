import { randomUUID } from 'node:crypto';
import { withActor } from '@manythreads/kernel';
import { GetTaskResponse, ListTaskEventsResponse } from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P35-03 (docs/plans/test-site-per-card.md): a card leases one of its team's test-site slots, one build runs at a time, a third card hears who holds
// the slots, and the server frees a slot (clearing the card's link) when the card is done, its pull request closed, or the site idles.

const { omar, nadia } = personas;
const TEAM = TEAM_IDS.Engineering;
const SLOTS = JSON.stringify([
  { team: 'engineering', namespace: 'test-manythreads', host: 'test.example.test' },
  { team: 'engineering', namespace: 'test-card-2', host: 'test2.example.test' },
]);

let server: TestServer;
let bot: { actorId: string };

type Who = { kind: 'person' | 'bot'; actorId: string };
async function call(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind, id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}
const as = <T>(who: Who, fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>) =>
  withActor({ kind: who.kind, id: who.actorId, workspaceId: KAHF_WORKSPACE_ID } as unknown as Parameters<typeof withActor>[0], (tx) => fn(async (sql, params = []) => (await tx.query(sql, params)).rows as Record<string, unknown>[]), {
    pool: server.pools.app,
  });
const lease = (who: Who, task: string, build = false) => as(who, async (q) => (await q('SELECT * FROM app.tasks_lease_test_site($1::uuid, $2)', [task, build]))[0]!);
const setSite = (who: Who, task: string, url: string) => as(who, async (q) => (await q('SELECT app.tasks_set_test_site($1::uuid, $2) AS o', [task, url]))[0]!['o']);
const system = (sql: string, params: unknown[] = []) => ownerSql(server.db.ownerUrl, sql, params);

/** A card the bot owns (claimed through the route, as a bot would). */
async function card(title: string): Promise<string> {
  const made = await call({ kind: 'person', actorId: nadia.actorId }, 'POST', '/api/teams/engineering/tasks', { title, branch: 'card-' + randomUUID().slice(0, 8) });
  expect(made.status, made.text).toBe(201);
  const id = (made.body['task'] as { id: string }).id;
  expect((await call({ kind: 'bot', actorId: bot.actorId }, 'POST', `/api/teams/engineering/tasks/${id}/claim`)).status).toBe(200);
  return id;
}
const get = async (id: string) => GetTaskResponse.parse((await call({ kind: 'person', actorId: nadia.actorId }, 'GET', `/api/teams/engineering/tasks/${id}`)).body).task;
const history = async (id: string) => ListTaskEventsResponse.parse((await call({ kind: 'person', actorId: nadia.actorId }, 'GET', `/api/teams/engineering/tasks/${id}/events`)).body).items;

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  const botId = randomUUID();
  const actorId = randomUUID();
  await system(`INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, 'deployer', 'Deployer', 'agent', 'hermes', 'team', $4, 'active')`, [botId, KAHF_WORKSPACE_ID, TEAM, 'a'.repeat(64)]);
  await system(`INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'bot', $2, $3)`, [actorId, KAHF_WORKSPACE_ID, botId]);
  await system(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [TEAM, actorId, KAHF_WORKSPACE_ID]);
  bot = { actorId };
}, 180_000);
afterAll(async () => {
  await server?.close();
});

const BOT: Who = { kind: 'bot', actorId: '' };
const asBot = (): Who => ({ ...BOT, actorId: bot.actorId });

describe('test-site slots', () => {
  it('says the team has none until the server lists them', async () => {
    const id = await card('Before any slot');
    expect(await lease(asBot(), id)).toMatchObject({ o_outcome: 'no_slots' });
    // a team without slots keeps the old rule: any https address
    expect(await setSite(asBot(), id, 'https://anywhere.example.test/')).toBe('recorded');
    await system("UPDATE app.tasks SET state = 'done', completed_at = now(), tested_sha = repeat('a', 40) WHERE id = $1", [id]);
  });

  it('leases each card a slot of its own, the same one again, and tells a third card who holds them', async () => {
    expect((await system('SELECT app.tasks_sync_test_site_slots($1::jsonb) AS n', [SLOTS]))[0]!['n']).toBe(2);
    const a = await card('Card A');
    const b = await card('Card B');
    const c = await card('Card C');
    const la = await lease(asBot(), a);
    expect(la).toMatchObject({ o_outcome: 'leased', o_namespace: 'test-card-2', o_host: 'test2.example.test' });
    expect(await lease(asBot(), a)).toMatchObject({ o_outcome: 'leased', o_namespace: 'test-card-2' });
    expect(await lease(asBot(), b)).toMatchObject({ o_outcome: 'leased', o_namespace: 'test-manythreads' });
    const busy = await lease(asBot(), c);
    expect(busy).toMatchObject({ o_outcome: 'busy' });
    expect(String(busy['o_holders'])).toContain('Card A');
    expect(String(busy['o_holders'])).toContain('Card B');
    // someone who neither owns the card nor leads the team
    expect(await lease({ kind: 'person', actorId: nadia.actorId }, c)).toMatchObject({ o_outcome: 'not_owner' });
    expect((await history(a)).some((l) => l.type === 'test_site_leased')).toBe(true);

    // one build at a time across the team's slots; recording the site lets the lock go
    expect(await lease(asBot(), a, true)).toMatchObject({ o_outcome: 'leased' });
    expect(await lease(asBot(), b, true)).toMatchObject({ o_outcome: 'build_busy', o_holders: expect.stringContaining('Card A') });
    // only the leased slot's host goes on the card
    expect(await setSite(asBot(), a, 'https://test.example.test/')).toBe('not_leased');
    expect(await setSite(asBot(), a, 'https://test2.example.test/')).toBe('recorded');
    expect(await lease(asBot(), b, true)).toMatchObject({ o_outcome: 'leased' });
    expect((await get(a)).testSiteUrl).toBe('https://test2.example.test/');

    // the server frees the slot of a finished card: the link goes, the history says why, and the third card gets it
    await system("UPDATE app.tasks SET state = 'done', completed_at = now(), tested_sha = repeat('a', 40) WHERE id = $1", [a]);
    const due = await system('SELECT * FROM app.tasks_release_test_sites($1::interval, $2::interval)', ['1 day', '3 days']);
    expect(due).toEqual([{ o_namespace: 'test-card-2', o_task_id: a, o_reason: 'the card is done' }]);
    expect(await lease(asBot(), c)).toMatchObject({ o_outcome: 'busy' });
    expect((await system('SELECT app.tasks_test_site_freed($1) AS o', ['test-card-2']))[0]!['o']).toBe('freed');
    expect((await get(a)).testSiteUrl).toBeNull();
    expect((await history(a)).find((l) => l.type === 'test_site_removed')?.data).toMatchObject({ namespace: 'test-card-2', reason: 'the card is done' });
    expect(await lease(asBot(), c)).toMatchObject({ o_outcome: 'leased', o_namespace: 'test-card-2' });
  });

  it('frees a site that idled a day, and hands out a slot whose teardown failed again until it is freed', async () => {
    const slots = await system("SELECT namespace, task_id FROM app.test_site_slots WHERE state = 'leased' ORDER BY namespace");
    const idle = slots.find((s) => s['namespace'] === 'test-manythreads')!;
    await system("UPDATE app.test_site_slots SET last_deploy_at = now() - interval '2 days' WHERE namespace = 'test-manythreads'");
    const due = await system('SELECT * FROM app.tasks_release_test_sites($1::interval, $2::interval)', ['1 day', '3 days']);
    expect(due).toEqual([{ o_namespace: 'test-manythreads', o_task_id: idle['task_id'], o_reason: 'no deploy for a day' }]);
    // the teardown failed: the next pass hands it out again, with its reason
    expect(await system('SELECT * FROM app.tasks_release_test_sites($1::interval, $2::interval)', ['1 day', '3 days'])).toEqual(due);
    await system('SELECT app.tasks_test_site_freed($1)', ['test-manythreads']);
    expect(await system('SELECT * FROM app.tasks_release_test_sites($1::interval, $2::interval)', ['1 day', '3 days'])).toEqual([]);
  });

  it('lets a team reader see the slots and nobody change them except through the doors', async () => {
    const seen = await as({ kind: 'person', actorId: omar.actorId }, (q) => q('SELECT namespace, state FROM app.test_site_slots ORDER BY namespace'));
    expect(seen.map((s) => s['namespace'])).toEqual(['test-card-2', 'test-manythreads']);
    await expect(as({ kind: 'person', actorId: omar.actorId }, (q) => q("UPDATE app.test_site_slots SET state = 'free'"))).rejects.toThrow();
    await expect(as(asBot(), (q) => q('SELECT app.tasks_test_site_freed($1)', ['test-card-2']))).rejects.toThrow();
  });
});
