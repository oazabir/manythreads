import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import {
  adoptOldConnection,
  createBotRunner,
  deleteBotRunner,
  fetchBotRunners,
  fetchOldConnections,
  setBotRunnerTeams,
  setDefaultBotRunner,
  testBotRunner,
  updateBotRunner,
} from '../src/screens/admin/runners/api';

/*
 * What the Runners page sends. The first half checks each call reaches the route the bot-runners plugin mounts (written out, not derived from the same route
 * objects the client uses). The second half runs the same calls against the mock transport, which the screens use offline: its answers must parse with the
 * shared schemas, hold no key, and refuse what the server refuses.
 */

const RUNNER = '00000000-0000-7000-8000-0000000d0001';
const CONNECTION = '00000000-0000-7000-8000-0000000e0002';

describe('the runner calls reach the routes the plugin mounts', () => {
  let seen: TransportRequest[] = [];
  beforeEach(() => {
    seen = [];
    // every call fails after it is recorded; only the request is under test here
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
  });
  const send = async (run: () => Promise<unknown>): Promise<TransportRequest> => {
    await run().catch(() => undefined);
    const req = seen.at(-1);
    if (!req) throw new Error('no request was sent');
    return req;
  };
  const cases: Array<{ name: string; run: () => Promise<unknown>; method: string; url: string; body?: unknown }> = [
    { name: 'lists runners', run: fetchBotRunners, method: 'GET', url: '/api/admin/bot-runners' },
    {
      name: 'adds a gateway',
      run: () => createBotRunner({ name: 'host', label: 'Office Hermes', kind: 'hermes_gateway', baseUrl: 'https://h.example.com', apiKey: 'gateway-key-0123' }),
      method: 'POST',
      url: '/api/admin/bot-runners',
      body: { name: 'host', label: 'Office Hermes', kind: 'hermes_gateway', baseUrl: 'https://h.example.com', apiKey: 'gateway-key-0123' },
    },
    { name: 'switches one off', run: () => updateBotRunner(RUNNER, { enabled: false }), method: 'PATCH', url: `/api/admin/bot-runners/${RUNNER}`, body: { enabled: false } },
    { name: 'deletes', run: () => deleteBotRunner(RUNNER), method: 'DELETE', url: `/api/admin/bot-runners/${RUNNER}` },
    { name: 'tests with a profile', run: () => testBotRunner(RUNNER, { profile: 'probe' }), method: 'POST', url: `/api/admin/bot-runners/${RUNNER}/test`, body: { profile: 'probe' } },
    { name: 'tests with no profile', run: () => testBotRunner(RUNNER), method: 'POST', url: `/api/admin/bot-runners/${RUNNER}/test`, body: {} },
    { name: 'shares with every team', run: () => setBotRunnerTeams(RUNNER, { all: true }), method: 'PUT', url: `/api/admin/bot-runners/${RUNNER}/teams`, body: { all: true } },
    { name: 'clears the default', run: () => setDefaultBotRunner(null), method: 'PUT', url: '/api/admin/bot-runners/default', body: { runnerId: null } },
    { name: 'sets the default', run: () => setDefaultBotRunner(RUNNER), method: 'PUT', url: '/api/admin/bot-runners/default', body: { runnerId: RUNNER } },
    { name: 'lists old connections', run: fetchOldConnections, method: 'GET', url: '/api/admin/bot-runners/old-connections' },
    { name: 'adopts', run: () => adoptOldConnection(CONNECTION, { name: 'laptop' }), method: 'POST', url: `/api/admin/bot-runners/old-connections/${CONNECTION}/adopt`, body: { name: 'laptop' } },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const req = await send(c.run);
      expect(req.method).toBe(c.method);
      expect(req.url.split('?')[0]).toBe(c.url);
      if (c.body !== undefined) expect(JSON.parse(req.body ?? 'null')).toEqual(c.body);
    });
  }

  it('refuses a body the schema does not know before it leaves the browser (a kind-changing patch, a key that is too short)', async () => {
    await expect(updateBotRunner(RUNNER, { kind: 'codex_cli' } as never)).rejects.toThrow();
    await expect(createBotRunner({ name: 'x', label: 'x', kind: 'hermes_gateway', apiKey: 'tiny' })).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('the mock transport answers like the server', () => {
  beforeEach(() => setTransport(createMockTransport({ latencyMs: 0 })));

  it('lists a starting set that parses, with a default and no key', async () => {
    const { items } = await fetchBotRunners();
    expect(items.map((r) => r.name)).toEqual(['host']);
    expect(items[0]).toMatchObject({ kind: 'hermes_gateway', hasKey: true, isDefault: true, status: 'ready' });
    expect(JSON.stringify(items)).not.toMatch(/apiKey|secret/i);
  });

  it('adds a gateway, tests it with the fixed sentence, shares it, makes it the default and refuses to switch the default off', async () => {
    const { items: before } = await fetchBotRunners();
    const eng = before[0]!.teams[0]!.teamId;
    const made = await createBotRunner({ name: 'lab', label: 'Lab Hermes', kind: 'hermes_gateway', baseUrl: 'https://lab.example.com', apiKey: 'lab-key-0123456', teams: { teams: [eng] } });
    expect(made.runner).toMatchObject({ name: 'lab', status: 'not_set_up', hasKey: true, allTeams: false });
    expect(JSON.stringify(made)).not.toContain('lab-key-0123456');
    await expect(createBotRunner({ name: 'lab', label: 'Again', kind: 'hermes_gateway', baseUrl: 'https://lab.example.com', apiKey: 'lab-key-0123456' })).rejects.toMatchObject({ status: 409 });
    await expect(createBotRunner({ name: 'cl', label: 'Claude', kind: 'claude_cli' })).rejects.toMatchObject({ status: 409 });

    const bad = await testBotRunner(made.runner.id, { profile: 'ghost' });
    expect(bad).toMatchObject({ ok: false, status: 'not_set_up', error: 'The gateway did not answer as a Hermes gateway for that profile.' });
    expect(await testBotRunner(made.runner.id, { profile: 'probe' })).toMatchObject({ ok: true, status: 'ready' });

    expect((await setBotRunnerTeams(made.runner.id, { all: true })).runner).toMatchObject({ allTeams: true, teams: [] });
    expect(await setDefaultBotRunner(made.runner.id)).toEqual({ defaultRunnerId: made.runner.id });
    expect((await fetchBotRunners()).items.filter((r) => r.isDefault).map((r) => r.name)).toEqual(['lab']);
    await expect(updateBotRunner(made.runner.id, { enabled: false })).rejects.toMatchObject({ status: 409 });
    expect(await setDefaultBotRunner(null)).toEqual({ defaultRunnerId: null });
    expect((await updateBotRunner(made.runner.id, { enabled: false })).runner).toMatchObject({ enabled: false, status: 'off' });
  });

  it('answers the way the server does for the edge cases: the Claude text, an LLM runner that is ready, a patch with no change', async () => {
    await expect(createBotRunner({ name: 'cl', label: 'Claude', kind: 'claude_cli' })).rejects.toMatchObject({ status: 409, message: 'Claude Code and Codex runners are not available yet.' });
    const llm = await createBotRunner({ name: 'plain', label: 'Plain', kind: 'llm_gateway', modelAlias: 'smart', teams: { all: true } });
    expect(llm.runner).toMatchObject({ status: 'ready', modelAlias: 'smart' });
    await expect(updateBotRunner(llm.runner.id, { label: 'Plain' })).rejects.toMatchObject({ status: 400, message: 'Nothing to change' });
  });

  it('refuses a delete while bots run there and says how many; a runner with none goes', async () => {
    const { items } = await fetchBotRunners();
    const host = items.find((r) => r.name === 'host')!;
    await expect(deleteBotRunner(host.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('2 bots are still placed on "Office Hermes"') });
    const pod = await createBotRunner({ name: 'pods', label: 'Pods', kind: 'hermes_pod', teams: { all: true } });
    expect(await deleteBotRunner(pod.runner.id)).toEqual({ deleted: true });
  });

  it('adopts an old connection into a runner for its team and removes it from the old list', async () => {
    const old = (await fetchOldConnections()).items;
    expect(old.map((c) => c.name)).toEqual(['laptop']);
    expect(old[0]).toMatchObject({ adoptable: true, botCount: 1 });
    const { runner } = await adoptOldConnection(old[0]!.id, {});
    expect(runner).toMatchObject({ name: 'laptop', kind: 'hermes_gateway', allTeams: false, botCount: 1 });
    expect(runner.teams.map((t) => t.slug)).toEqual(['marketing']);
    expect((await fetchOldConnections()).items).toEqual([]);
  });
});
