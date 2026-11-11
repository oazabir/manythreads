import { expect, test } from '@playwright/test';
import { actorOf } from '../files/support.ts';
import { apiOn } from '../support/stack-browser.ts';
import { ask, expectNoLeak, fill, foundIn, hasKey, NODE_CANARY, podNames, runnerRoutes, SECRET_FIELDS, SEED_VALUES, startRunnersWorld, type Answer, type RunnersWorld } from './support.ts';

/*
 * PLAN P19-12, "visibility": a team lead, a member and a guest cannot learn a runner's address, key, node or sign-in detail from any route of the runner and bot APIs, from an error,
 * or from the pages of a bot. The routes are not listed here: every `*Route` of @manythreads/shared under the runner and bot prefixes is walked (support.ts), so a route added later is
 * walked too. The values searched for are the ones the runners world (seed v19) plants: the host Hermes' address and key, the canary inside both made-up Claude logins, the pods' Secret
 * names and namespace, and the name of the one machine of the stand-in cluster. A control first proves the values really are in the system (an admin sees the machine; the database
 * holds the address), so an empty search means something.
 */
test.skip(({ isMobile }) => isMobile, 'API walk and desktop pages; the phone width is read by the persona suites');
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

let world: RunnersWorld;
let ids = { runnerId: '', botId: '', slug: 'engineering', botSlug: 'code-helper' };
let needles: string[] = [];
const BRIDGE = { name: 'host-claude', url: 'http://10.42.0.1:8650', host: '10.42.0.1:8650', key: 'host-bridge-key-CANARY-P1914' } as const;

test.beforeAll(async ({ playwright }) => {
  world = await startRunnersWorld();
  // Nadia is a plain member of Engineering in the seed; the lead of this proof is she, promoted (as the roster and placement specs do)
  await world.stack.sql("UPDATE app.team_members SET role = 'lead' WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND actor_id = $1", [actorOf('nadia')]);
  const runner = (await world.stack.sql<{ id: string }>("SELECT id FROM app.bot_runners WHERE name = 'claude-shared'"))[0]!;
  const bot = (await world.stack.sql<{ id: string }>("SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = 'code-helper'"))[0]!;
  ids = { ...ids, runnerId: runner.id, botId: bot.id };
  // P19-14: a gateway runner that fronts the agent bridge on the host (its address and key are as secret as any gateway's); made through the admin API like the seed's runners
  const omar = await apiOn(playwright, world.stack, 'omar');
  try {
    const made = await omar.ctx.fetch('/api/admin/bot-runners', {
      method: 'POST',
      headers: { ...(await omar.headers()), 'content-type': 'application/json' },
      data: JSON.stringify({ name: BRIDGE.name, label: 'Claude Code on the host', kind: 'hermes_gateway', baseUrl: BRIDGE.url, apiKey: BRIDGE.key, agent: 'claude-code', teams: { all: true } }),
      failOnStatusCode: false,
    });
    expect(made.status(), await made.text()).toBe(201);
  } finally {
    await omar.ctx.dispose();
  }
  needles = [...SEED_VALUES, ...podNames(world.k8s), BRIDGE.url, BRIDGE.host, BRIDGE.key];
});
test.afterAll(async () => {
  await world?.stop();
});

test('control: the values are really in the system, and an admin sees only what the Machine picker is for', async ({ playwright }) => {
  // the address is in the database (the runner row), the sign-ins are in the stand-in cluster's Secrets, the machine is in the stand-in cluster's node list
  const row = (await world.stack.sql<{ base_url: string }>("SELECT base_url FROM app.bot_runners WHERE name = 'office-hermes'"))[0]!;
  expect(row.base_url).toContain('192.168.50.20');
  const secrets = [...world.k8s.secrets.entries()].filter(([k]) => k.endsWith('-credentials'));
  expect(secrets.length).toBeGreaterThanOrEqual(2);
  expect(secrets.map(([, v]) => Buffer.from(Object.values(v.data ?? {})[0] ?? '', 'base64').toString('utf8')).join('\n')).toContain('CANARY-SEEDRUNNERS-3c8d');

  const omar = await apiOn(playwright, world.stack, 'omar');
  try {
    const nodes = await ask(omar, 'GET', '/api/admin/bot-runners/nodes');
    expect(nodes.status, nodes.text).toBe(200);
    expect(nodes.text, 'the admin picks a machine by its name, so the admin sees it').toContain(NODE_CANARY);
    // and even the admin's own list never carries a key or a sign-in value
    const list = await ask(omar, 'GET', '/api/admin/bot-runners');
    expect(list.status).toBe(200);
    expect(list.text).toContain('claude-shared');
    for (const v of ['CANARY-SEEDRUNNERS-3c8d', 'seed-hermes-key', 'fake-access-', 'fake-refresh-']) expect(list.text).not.toContain(v);
    for (const f of SECRET_FIELDS) expect(hasKey(list.text, f), f).toBe(false);
  } finally {
    await omar.ctx.dispose();
  }
});

test('the walk covers the routes it should (a route that is not walked cannot be proved)', () => {
  const routes = runnerRoutes();
  const names = routes.map((r) => r.name);
  for (const must of ['listBotRunnersRoute', 'createBotRunnerRoute', 'putClaudeCredentialsRoute', 'listRunnerNodesRoute', 'setRunnerNodeRoute', 'listTeamBotRunnersRoute', 'getBotRoute', 'listBotsRoute', 'mintPairingTokenRoute', 'mintRunnerTokenRoute', 'runnerConnectRoute', 'runSelfRoute']) {
    expect(names, must).toContain(must);
  }
  expect(routes.length).toBeGreaterThanOrEqual(25);
});

for (const who of ['nadia', 'rafi', 'lena'] as const) {
  test(`${who} (${{ nadia: 'team lead', rafi: 'member', lena: 'guest' }[who]}) walks every route of the runner and bot APIs and learns nothing`, async ({ playwright }) => {
    const api = await apiOn(playwright, world.stack, who);
    const answers: Answer[] = [];
    try {
      const routes = runnerRoutes();
      // three teams: the one the runners serve, one they serve with another runner, and one the person may not be on; and a made-up id for every parameter
      for (const team of ['engineering', 'marketing', 'customer-support']) {
        for (const route of routes) {
          answers.push(await ask(api, route.method, fill(route.path, { ...ids, slug: team })));
        }
      }
      for (const route of routes) answers.push(await ask(api, route.method, fill(route.path, { runnerId: 'nope', botId: 'nope', slug: 'nope', botSlug: 'nope' })));
    } finally {
      await api.ctx.dispose();
    }
    expect(answers.length).toBeGreaterThanOrEqual(100);
    for (const a of answers) {
      expect(a.status, `${a.route}: ${a.text.slice(0, 200)}`).toBeLessThan(500);
      expectNoLeak(a, needles);
      // an admin route is shut to everyone who is not an admin; a body that does not fit is refused (400) before the rights check, which tells nothing (no leak is asserted above) and is the same for every caller
      if (a.route.split(' ')[1]!.startsWith('/api/admin/')) expect([400, 401, 403, 404], a.route).toContain(a.status);
    }
    // something real was answered (so an empty search above is not an empty walk): the team's own runner list names the runners the team may use, without their addresses
    if (who !== 'lena') {
      const seen = answers.find((a) => a.route === 'GET /api/teams/engineering/bot-runners');
      expect(seen?.status, seen?.text).toBe(200);
      expect(seen!.text).toContain('claude-shared');
    }
    expect(foundIn(answers.map((a) => a.text).join('\n'), needles)).toBeNull();
  });
}

test('the pages of a bot show a lead, a member and a guest nothing of the runner but its name', async ({ browser, playwright }) => {
  for (const who of ['nadia', 'rafi', 'lena'] as const) {
    const api = await apiOn(playwright, world.stack, who);
    const state = await api.ctx.storageState();
    await api.ctx.dispose();
    const context = await browser.newContext({ baseURL: world.stack.origin, storageState: state, reducedMotion: 'reduce' });
    const bodies: string[] = [];
    const page = await context.newPage();
    page.on('response', (res) => {
      if (res.url().includes('/api/')) void res.text().then((t) => bodies.push(`${res.url()}\n${t}`)).catch(() => undefined);
    });
    try {
      for (const path of ['/t/engineering/bots', '/t/engineering/bots/code-helper', '/t/engineering/bots/code-helper/usage', '/t/engineering/bots/desk-helper', '/t/engineering/bots/pod-helper']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        const html = await page.content();
        const hit = foundIn(html, needles);
        expect(hit, `${who} ${path}: the page holds "${hit ?? ''}"`).toBeNull();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      const all = bodies.join('\n');
      expect(foundIn(all, needles), `${who}: a response the pages fetched`).toBeNull();
      for (const f of SECRET_FIELDS) expect(hasKey(all, f), `${who}: a fetched response has a field ${f}`).toBe(false);
      if (who === 'nadia') expect(bodies.length, 'the pages fetched something to read').toBeGreaterThan(3);
    } finally {
      await context.close();
    }
  }
});

test('a gateway runner that fronts the bridge: only an admin sets or reads what runs behind it, and a team sees the same eight fields as for any runner', async ({ playwright }) => {
  const omar = await apiOn(playwright, world.stack, 'omar');
  try {
    const list = await ask(omar, 'GET', '/api/admin/bot-runners');
    expect(list.text, 'control: the admin sees it').toMatch(/"name":"host-claude"[^}]*"agent":"claude-code"|"agent":"claude-code"[^}]*"name":"host-claude"/);
    expect(list.text).not.toContain(BRIDGE.key);
  } finally {
    await omar.ctx.dispose();
  }
  for (const who of ['nadia', 'rafi'] as const) {
    const api = await apiOn(playwright, world.stack, who);
    try {
      const headers = { ...(await api.headers()), 'content-type': 'application/json' };
      const create = await api.ctx.fetch('/api/admin/bot-runners', { method: 'POST', headers, data: JSON.stringify({ name: 'sneaky', label: 'x', kind: 'hermes_gateway', baseUrl: BRIDGE.url, apiKey: BRIDGE.key, agent: 'codex' }), failOnStatusCode: false });
      expect(create.status(), `${who} create`).toBe(403);
      const id = (await world.stack.sql<{ id: string }>("SELECT id FROM app.bot_runners WHERE name = 'host-claude'"))[0]!.id;
      const patch = await api.ctx.fetch(`/api/admin/bot-runners/${id}`, { method: 'PATCH', headers, data: JSON.stringify({ agent: 'codex' }), failOnStatusCode: false });
      expect(patch.status(), `${who} patch`).toBe(403);
      const team = await ask(api, 'GET', '/api/teams/engineering/bot-runners');
      expect(team.status, team.text).toBe(200);
      const items = (JSON.parse(team.text) as { items: Array<Record<string, unknown>> }).items;
      const mine = items.find((r) => r['name'] === 'host-claude');
      expect(mine, `${who}: the runner is in the team's list by name`).toBeDefined();
      expect(Object.keys(mine!).sort()).toEqual(['isDefault', 'kind', 'label', 'name', 'ownerName', 'planLabel', 'sharedWith', 'status']);
      expect(team.text).not.toContain('claude-code');
      expectNoLeak(team, needles);
    } finally {
      await api.ctx.dispose();
    }
  }
  expect((await world.stack.sql<{ agent: string }>("SELECT agent FROM app.bot_runners WHERE name = 'host-claude'"))[0]!.agent).toBe('claude-code');
});
