/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { putSecret } from '@manythreads/kernel';
import { TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeHermesGateway, type FakeHermesGateway } from '../../../../tools/fake-hermes-gateway/src/server.ts';
import { createWorld, personas, type World } from './world.ts';

// The runner catalog over HTTP: an admin makes, tests, shares, adopts and removes runners; a lead and a member can read none of an address, a key or a node by any
// route or in any error. The fake gateway stands in for a customer's Hermes.

const { omar, nadia, tariq } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const KEY = 'gateway-key-0123456789abcdef';
const OTHER_KEY = 'another-key-0123456789abcdef';
let w: World;
let gw: FakeHermesGateway;
const savedAllowed = process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'];

const SECRETS = (): string[] => [KEY, OTHER_KEY, gw.url, '127.0.0.1'];
/** Nothing a non-admin is shown may carry an address, a key or a node. */
const expectNoSecrets = (what: unknown, ...more: string[]): void => {
  const text = JSON.stringify(what);
  for (const s of [...SECRETS(), ...more]) expect(text, s).not.toContain(s);
};

const adminCreate = async (body: Record<string, unknown>) => w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', body);

beforeAll(async () => {
  process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = '127.0.0.1';
  gw = await startFakeHermesGateway({ profiles: {} });
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w?.close();
  await gw?.close();
  if (savedAllowed === undefined) delete process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'];
  else process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = savedAllowed;
});

describe('an admin makes, changes, tests and removes a Hermes gateway runner', () => {
  let id = '';

  it('makes one: the key is stored encrypted and never returned; it starts "not set up" and shared with nobody', async () => {
    const made = await adminCreate({ name: 'host', label: 'Office Hermes', kind: 'hermes_gateway', baseUrl: gw.url, apiKey: KEY });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    id = made.body.runner.id;
    expect(made.body.runner).toMatchObject({ name: 'host', label: 'Office Hermes', kind: 'hermes_gateway', enabled: true, isDefault: false, allTeams: false, teams: [], baseUrl: gw.url, hasKey: true, profileRule: '{bot}', status: 'not_set_up', botCount: 0 });
    expect(JSON.stringify(made.body)).not.toContain(KEY);
    const row = await w.system(async (tx) => (await tx.query<{ secret_id: string; base_url: string }>('SELECT secret_id, base_url FROM app.bot_runners WHERE id = $1', [id])).rows[0]);
    expect(row?.secret_id).toBeTruthy();
    const stored = await w.system(async (tx) => (await tx.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM app.secrets WHERE id = $1', [row!.secret_id])).rows[0]);
    expect(stored?.ciphertext.toString('utf8')).not.toContain(KEY);
    const listed = await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((r) => r.name)).toEqual(['host']);
    expect(JSON.stringify(listed.body)).not.toContain(KEY);
  });

  it('refuses a second runner of the same name, an address without a key, a key on a pod, and an address the server may not call', async () => {
    expect((await adminCreate({ name: 'host', label: 'Again', kind: 'hermes_gateway', baseUrl: gw.url, apiKey: KEY })).status).toBe(409);
    expect((await adminCreate({ name: 'no-key', label: 'No key', kind: 'hermes_gateway', baseUrl: gw.url })).status).toBe(400);
    expect((await adminCreate({ name: 'pod-key', label: 'Pod', kind: 'hermes_pod', apiKey: KEY })).status).toBe(400);
    expect((await adminCreate({ name: 'Bad Name', label: 'x', kind: 'hermes_pod' })).status).toBe(400);
    const saved = process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'];
    delete process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'];
    try {
      const refused = await adminCreate({ name: 'evil', label: 'Evil', kind: 'hermes_gateway', baseUrl: 'http://169.254.169.254/latest', apiKey: KEY });
      expect(refused.status).toBe(400);
    } finally {
      process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = saved;
    }
  });

  it('tests it: the three fixed sentences, the answer recorded on the runner, and a new key sends it back to "not set up"', async () => {
    gw.setProfile('probe', { apiKey: KEY });
    const ok = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, { profile: 'probe' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, error: null, status: 'ready' });
    expect((await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items[0]).toMatchObject({ status: 'ready' });

    const ghost = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, { profile: 'ghost' });
    expect(ghost.body).toMatchObject({ ok: false, status: 'not_set_up' });
    expect(ghost.body.error).toContain('did not answer as a Hermes gateway for that profile');

    const rekeyed = await w.call<{ runner: any }>(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { apiKey: OTHER_KEY });
    expect(rekeyed.status, JSON.stringify(rekeyed.body)).toBe(200);
    expect(rekeyed.body.runner).toMatchObject({ status: 'not_set_up', hasKey: true });
    expect(JSON.stringify(rekeyed.body)).not.toContain(OTHER_KEY);
    const wrong = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, { profile: 'probe' });
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.error).toContain('refused the API key');
    expect(JSON.stringify(wrong.body)).not.toContain(OTHER_KEY);
    // the old key's secret is gone, the new one is the only one this runner holds
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.secrets s WHERE s.id IN (SELECT secret_id FROM app.bot_runners)')).rows.length)).toBe(1);

    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { apiKey: KEY })).status).toBe(200);
    expect((await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, { profile: 'probe' })).body).toMatchObject({ ok: true, status: 'ready' });
    const dead = await startFakeHermesGateway({ profiles: {} });
    const deadUrl = dead.url;
    await dead.close();
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { baseUrl: deadUrl })).status).toBe(200);
    const down = await w.call<any>(omar, 'POST', `/api/admin/bot-runners/${id}/test`, { profile: 'probe' });
    expect(down.body).toMatchObject({ ok: false, status: 'not_set_up' });
    expect(JSON.stringify(down.body)).not.toContain(deadUrl);
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { baseUrl: gw.url })).status).toBe(200);
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, {})).status).toBe(400);
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { kind: 'codex_cli' })).status).toBe(400);
  });

  it('switching it off reads "off" whatever was last found; switching it on brings the last answer back', async () => {
    const off = await w.call<{ runner: any }>(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { enabled: false });
    expect(off.body.runner).toMatchObject({ enabled: false, status: 'off' });
    expect((await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items[0]).toMatchObject({ status: 'off' });
    expect((await w.call<{ runner: any }>(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { enabled: true })).body.runner.enabled).toBe(true);
  });

  it('the events say that it happened and never what it was', async () => {
    const events = await w.system(async (tx) => (await tx.query<{ type: string; payload: unknown }>(`SELECT type, payload FROM app.events WHERE type LIKE 'bot_runner.%' ORDER BY id`)).rows);
    const types = new Set(events.map((e) => e.type));
    expect(types).toEqual(new Set(['bot_runner.runner.created', 'bot_runner.runner.updated', 'bot_runner.runner.tested', 'bot_runner.availability.changed']));
    expectNoSecrets(events);
  });

  it('removes it with its key', async () => {
    const gone = await w.call(omar, 'DELETE', `/api/admin/bot-runners/${id}`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.bot_runners')).rows.length)).toBe(0);
    expect(await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.secrets WHERE id NOT IN (SELECT secret_id FROM app.hermes_connections WHERE secret_id IS NOT NULL)")).rows.length)).toBeLessThanOrEqual(0);
    expect((await w.call(omar, 'DELETE', `/api/admin/bot-runners/${id}`)).status).toBe(404);
  });
});

describe('the other kinds', () => {
  it('Claude Code and Codex answer "not available yet"; the pod and the LLM gateway can be made', async () => {
    for (const kind of ['claude_cli', 'codex_cli']) {
      const res = await adminCreate({ name: `x-${kind.replace('_', '-')}`, label: 'Later', kind });
      expect(res.status, kind).toBe(409);
      expect(JSON.stringify(res.body)).toContain('not available yet');
    }
    const pod = await adminCreate({ name: 'pod', label: 'Team Hermes pod', kind: 'hermes_pod' });
    expect(pod.status, JSON.stringify(pod.body)).toBe(201);
    expect(pod.body.runner).toMatchObject({ kind: 'hermes_pod', status: 'ready', baseUrl: null, hasKey: false });

    expect((await adminCreate({ name: 'llm-none', label: 'LLM', kind: 'llm_gateway' })).status).toBe(400);
    expect((await adminCreate({ name: 'llm-bad', label: 'LLM', kind: 'llm_gateway', modelAlias: 'not-an-alias' })).status).toBe(400);
    const unbound = await adminCreate({ name: 'llm', label: 'LLM gateway', kind: 'llm_gateway', modelAlias: 'smart' });
    expect(unbound.status, JSON.stringify(unbound.body)).toBe(201);
    expect(unbound.body.runner).toMatchObject({ status: 'not_set_up', modelAlias: 'smart' });
    await w.system((tx) => tx.query("INSERT INTO app.llm_aliases (workspace_id, alias, model) VALUES ($1, 'fast', 'some-model')", [omar.workspaceId]));
    const bound = await w.call<{ runner: any }>(omar, 'PATCH', `/api/admin/bot-runners/${unbound.body.runner.id}`, { modelAlias: 'fast' });
    expect(bound.body.runner).toMatchObject({ status: 'ready', modelAlias: 'fast' });
    // the pod cannot take an address and the gateway cannot take a model alias
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${pod.body.runner.id}`, { baseUrl: gw.url })).status).toBe(400);
    for (const r of [pod.body.runner.id, unbound.body.runner.id]) expect((await w.call(omar, 'DELETE', `/api/admin/bot-runners/${r}`)).status).toBe(200);
  });
});

describe('who a runner is shared with, and the default', () => {
  let a = '';
  let b = '';

  it('the list is the permission: a team sees a runner only when it is on the list or the runner is for every team', async () => {
    a = (await adminCreate({ name: 'only-eng', label: 'Engineering pod', kind: 'hermes_pod', teams: { teams: [TEAM_IDS.Engineering] } })).body.runner.id;
    b = (await adminCreate({ name: 'for-all', label: 'Everyone pod', kind: 'hermes_pod', teams: { all: true } })).body.runner.id;
    const view = async (who: typeof omar, slug: string) => (await w.call<{ items: any[] }>(who, 'GET', `/api/teams/${slug}/bot-runners`));
    const eng = await view(nadia, 'engineering');
    expect(eng.status).toBe(200);
    expect(eng.body.items.map((r) => r.name).sort()).toEqual(['for-all', 'only-eng']);
    // the short view: name, label, kind, status, isDefault, ownerName, planLabel, sharedWith — and no more
    for (const item of eng.body.items) expect(Object.keys(item).sort()).toEqual(['isDefault', 'kind', 'label', 'name', 'ownerName', 'planLabel', 'sharedWith', 'status']);
    expect((await view(tariq, 'marketing')).body.items.map((r) => r.name)).toEqual(['for-all']);
    // a lead or a member of another team is refused the team's view
    expect((await view(tariq, 'engineering')).status).toBe(403);
    expect((await view(nadia, 'marketing')).status).toBe(403);
    expectNoSecrets([eng.body, (await view(tariq, 'marketing')).body]);
  });

  it('an admin changes the list; a team removed from it stops seeing the runner', async () => {
    const set = await w.call<{ runner: any }>(omar, 'PUT', `/api/admin/bot-runners/${a}/teams`, { teams: [TEAM_IDS.Marketing] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.runner).toMatchObject({ allTeams: false });
    expect(set.body.runner.teams.map((t: any) => t.slug)).toEqual(['marketing']);
    expect((await w.call<{ items: any[] }>(nadia, 'GET', '/api/teams/engineering/bot-runners')).body.items.map((r) => r.name)).toEqual(['for-all']);
    const all = await w.call<{ runner: any }>(omar, 'PUT', `/api/admin/bot-runners/${a}/teams`, { all: true });
    expect(all.body.runner).toMatchObject({ allTeams: true, teams: [] });
    expect((await w.call(omar, 'PUT', `/api/admin/bot-runners/${a}/teams`, { teams: ['00000000-0000-7000-8000-00000000dead'] })).status).toBe(409);
    expect((await w.call(omar, 'PUT', `/api/admin/bot-runners/${a}/teams`, { everyone: true })).status).toBe(400);
  });

  it('one default at most; a switched-off runner cannot be the default and the default cannot be switched off', async () => {
    const set = await w.call<any>(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId: a });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({ defaultRunnerId: a });
    expect((await w.call<any>(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId: b })).body).toEqual({ defaultRunnerId: b });
    const items = (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items;
    expect(items.filter((r) => r.isDefault).map((r) => r.id)).toEqual([b]);
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${b}`, { enabled: false })).status).toBe(409);
    await w.call(omar, 'PATCH', `/api/admin/bot-runners/${a}`, { enabled: false });
    expect((await w.call(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId: a })).status).toBe(409);
    expect((await w.call(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId: '00000000-0000-7000-8000-00000000dead' })).status).toBe(404);
    expect((await w.call<any>(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId: null })).body).toEqual({ defaultRunnerId: null });
    expect((await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items.some((r) => r.isDefault)).toBe(false);
    // the team view carries the flag and the off state
    await w.call(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId: b });
    const view = (await w.call<{ items: any[] }>(nadia, 'GET', '/api/teams/engineering/bot-runners')).body.items;
    expect(view.find((r) => r.name === 'for-all')).toMatchObject({ isDefault: true, status: 'ready' });
    expect(view.find((r) => r.name === 'only-eng')).toMatchObject({ isDefault: false, status: 'off' });
    const types = await w.system(async (tx) => (await tx.query<{ type: string }>("SELECT DISTINCT type FROM app.events WHERE type = 'bot_runner.default.changed'")).rows.length);
    expect(types).toBe(1);
    expect((await w.call(omar, 'PUT', '/api/admin/bot-runners/default', { runnerId: null })).status).toBe(200);
    for (const r of [a, b]) expect((await w.call(omar, 'DELETE', `/api/admin/bot-runners/${r}`)).status).toBe(200);
  });
});

describe('a team lead and a member read nothing of a runner by any route', () => {
  it('every admin route answers 403, and no answer or error carries an address, a key or a node', async () => {
    const made = await adminCreate({ name: 'secret-host', label: 'Secret host', kind: 'hermes_gateway', baseUrl: gw.url, apiKey: KEY, teams: { all: true } });
    const id = made.body.runner.id;
    await w.call(omar, 'POST', '/api/admin/bot-runners', { name: 'noded', label: 'On a node', kind: 'hermes_pod', node: 'worker-17.internal' });
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/admin/bot-runners'],
      ['POST', '/api/admin/bot-runners', { name: 'x', label: 'x', kind: 'hermes_pod' }],
      ['PATCH', `/api/admin/bot-runners/${id}`, { label: 'x' }],
      ['DELETE', `/api/admin/bot-runners/${id}`],
      ['POST', `/api/admin/bot-runners/${id}/test`, {}],
      ['PUT', `/api/admin/bot-runners/${id}/teams`, { all: true }],
      ['PUT', '/api/admin/bot-runners/default', { runnerId: id }],
      ['GET', '/api/admin/bot-runners/old-connections'],
      ['POST', '/api/admin/bot-runners/old-connections/00000000-0000-7000-8000-00000000dead/adopt', {}],
    ];
    for (const who of [tariq, nadia]) {
      for (const [method, path, body] of routes) {
        const res = await w.call(who, method, path, body);
        expect(res.status, `${who.name} ${method} ${path}`).toBe(403);
        expectNoSecrets(res.body, 'worker-17');
      }
    }
    // a guessed id answers the same as a real one
    expect((await w.call(tariq, 'PATCH', '/api/admin/bot-runners/00000000-0000-7000-8000-00000000dead', { label: 'x' })).status).toBe(403);
    // the team view of the lead's own team has the runner by name and kind only
    const view = await w.call<{ items: any[] }>(tariq, 'GET', '/api/teams/marketing/bot-runners');
    expect(view.status).toBe(200);
    expect(view.body.items.map((r) => r.name).sort()).toEqual(['secret-host']);
    expectNoSecrets(view.body, 'worker-17');
    // not signed in: no
    expect([401, 403]).toContain((await w.call(null, 'GET', '/api/admin/bot-runners')).status);
    for (const r of (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items) await w.call(omar, 'DELETE', `/api/admin/bot-runners/${r.id}`);
  });
});

describe('adopting a team\'s old connection', () => {
  const seed = async (team: string, name: string, kind: 'external' | 'managed', agent: string, baseUrl: string | null, key: string | null): Promise<string> =>
    w.system(async (tx) => {
      const secretId = key === null ? null : await putSecret(tx, key);
      return (
        await tx.query<{ id: string }>(
          `INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, agent, base_url, secret_id, status)
           SELECT t.workspace_id, t.id, $2, $3, $4, $5, $6::uuid, 'ok' FROM app.teams t WHERE t.slug = $1 RETURNING id`,
          [team, name, kind, agent, baseUrl, secretId],
        )
      ).rows[0]!.id;
    });

  it('lists the old connections for an admin with the team and the number of bots on each; the key is not in the list', async () => {
    await seed('engineering', 'host', 'external', 'hermes', gw.url, KEY);
    await seed('engineering', 'bridge', 'external', 'claude-code', gw.url, KEY);
    await seed('engineering', 'managed', 'managed', 'hermes', 'http://pod.internal:8642', null);
    const list = await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners/old-connections');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((c) => `${c.teamSlug}/${c.name}`)).toEqual(['engineering/bridge', 'engineering/host', 'engineering/managed']);
    expect(list.body.items.find((c) => c.name === 'host')).toMatchObject({ kind: 'external', agent: 'hermes', adoptable: true, adoptableReason: null, botCount: 0 });
    expect(list.body.items.find((c) => c.name === 'bridge')).toMatchObject({ adoptable: false });
    expect(JSON.stringify(list.body)).not.toContain(KEY);
  });

  it('adopts a gateway: a runner with the same address and its own copy of the key, for that team only; the old row keeps its name', async () => {
    const list = await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners/old-connections');
    const host = list.body.items.find((c) => c.name === 'host');
    const adopted = await w.call<{ runner: any }>(omar, 'POST', `/api/admin/bot-runners/old-connections/${host.id}/adopt`, {});
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    expect(adopted.body.runner).toMatchObject({ name: 'host', kind: 'hermes_gateway', baseUrl: gw.url, hasKey: true, allTeams: false, status: 'ready' });
    expect(adopted.body.runner.teams.map((t: any) => t.slug)).toEqual(['engineering']);
    expect(JSON.stringify(adopted.body)).not.toContain(KEY);
    // it is no longer "old"
    expect((await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners/old-connections')).body.items.map((c) => c.name)).toEqual(['bridge', 'managed']);
    expect(await w.system(async (tx) => (await tx.query<{ runner_name: string }>("SELECT runner_name FROM app.hermes_connections WHERE name = 'host'")).rows[0]?.runner_name)).toBe('host');
    // twice, a Claude Code connection, an unknown one
    expect((await w.call(omar, 'POST', `/api/admin/bot-runners/old-connections/${host.id}/adopt`, {})).status).toBe(409);
    const bridge = list.body.items.find((c) => c.name === 'bridge');
    expect((await w.call(omar, 'POST', `/api/admin/bot-runners/old-connections/${bridge.id}/adopt`, {})).status).toBe(409);
    expect((await w.call(omar, 'POST', '/api/admin/bot-runners/old-connections/00000000-0000-7000-8000-00000000dead/adopt', {})).status).toBe(404);
    // the team's lead (not an admin) still sees the team's runner by name only
    expect((await w.call<{ items: any[] }>(nadia, 'GET', '/api/teams/engineering/bot-runners')).body.items.map((r) => r.name)).toEqual(['host']);
  });

  it('adopts the team\'s own pod into one shared pod runner; a second team joins the same runner', async () => {
    const list = await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners/old-connections');
    const managed = list.body.items.find((c) => c.name === 'managed');
    const adopted = await w.call<{ runner: any }>(omar, 'POST', `/api/admin/bot-runners/old-connections/${managed.id}/adopt`, {});
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(201);
    expect(adopted.body.runner).toMatchObject({ name: 'team-pod', kind: 'hermes_pod', baseUrl: null, hasKey: false, status: 'ready' });
    expect(adopted.body.runner.teams.map((t: any) => t.slug)).toEqual(['engineering']);
    await seed('marketing', 'managed', 'managed', 'hermes', 'http://pod2.internal:8642', null);
    const second = (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners/old-connections')).body.items.find((c) => c.teamSlug === 'marketing');
    const joined = await w.call<{ runner: any }>(omar, 'POST', `/api/admin/bot-runners/old-connections/${second.id}/adopt`, {});
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect(joined.body.runner.id).toBe(adopted.body.runner.id);
    expect(joined.body.runner.teams.map((t: any) => t.slug).sort()).toEqual(['engineering', 'marketing']);
  });

  it('refuses to link a team\'s pod to the shared pod runner while an admin has it switched off, and links once it is on', async () => {
    const pod = (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items.find((r) => r.name === 'team-pod');
    await seed('customer-support', 'managed', 'managed', 'hermes', 'http://pod3.internal:8642', null);
    const third = (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners/old-connections')).body.items.find((c) => c.teamSlug === 'customer-support');
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${pod.id}`, { enabled: false })).status).toBe(200);
    const refused = await w.call<{ message?: string }>(omar, 'POST', `/api/admin/bot-runners/old-connections/${third.id}/adopt`, {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('switched off');
    // nothing was linked and the team was not added to the list
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.hermes_connections WHERE id = $1 AND runner_name IS NOT NULL', [third.id])).rows.length)).toBe(0);
    expect((await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items.find((r) => r.name === 'team-pod').teams.map((t: any) => t.slug).sort()).toEqual(['engineering', 'marketing']);
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${pod.id}`, { enabled: true })).status).toBe(200);
    expect((await w.call(omar, 'POST', `/api/admin/bot-runners/old-connections/${third.id}/adopt`, {})).status).toBe(201);
  });

  it('deleting an adopted runner removes its gateway connection and only unlinks the pod', async () => {
    const runners = (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items;
    for (const r of runners) expect((await w.call(omar, 'DELETE', `/api/admin/bot-runners/${r.id}`)).status, r.name).toBe(200);
    const left = await w.system(async (tx) => (await tx.query<{ name: string; runner_name: string | null }>('SELECT name, runner_name FROM app.hermes_connections ORDER BY name')).rows);
    expect(left.map((c) => c.name)).toEqual(['bridge', 'managed', 'managed', 'managed']);
    expect(left.every((c) => c.runner_name === null)).toBe(true);
  });
});

describe('a runner with bots on it cannot be deleted', () => {
  it('answers 409 with the number of bots and the names of their teams, and leaves the runner alone', async () => {
    const made = await adminCreate({ name: 'busy', label: 'Busy pod', kind: 'hermes_pod', teams: { all: true } });
    const id = made.body.runner.id;
    // two bots in two teams placed on it by `runs_on`
    await w.system(async (tx) => {
      for (const [team, slug] of [['engineering', 'busy-a'], ['marketing', 'busy-b']] as const) {
        await tx.query(
          `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status, placement)
           SELECT t.workspace_id, t.id, $2, 'agent', 'hermes', 'team', repeat('a', 64), 'active', '{"runs_on":"busy"}'::jsonb FROM app.teams t WHERE t.slug = $1`,
          [team, slug],
        );
      }
    });
    const refused = await w.call<any>(omar, 'DELETE', `/api/admin/bot-runners/${id}`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const text = JSON.stringify(refused.body);
    expect(text).toContain('2 bots');
    expect(text).toContain('Engineering');
    expect(text).toContain('Marketing');
    expect((await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items[0]).toMatchObject({ name: 'busy', botCount: 2 });
    await w.system((tx) => tx.query("DELETE FROM app.bots WHERE slug IN ('busy-a', 'busy-b')"));
    expect((await w.call(omar, 'DELETE', `/api/admin/bot-runners/${id}`)).status).toBe(200);
  });
});
