/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeK8s, TEAM_IDS, type FakeK8s } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../../../tools/agent-bridge/src/config.ts';
import { startBridge, type Bridge } from '../../../../tools/agent-bridge/src/server.ts';
import { createWorld, personas, type World } from './world.ts';

// P35-10a (docs/plans/per-team-sign-in.md sections 1, 2 and 7): who signs a pod runner in, one sign-in for all teams or each team on its own. The switch signs the old sign-ins out for
// real first, through the pods' bridges; the agent-auth routes take the team; the per-team list reads stored states. A real bridge on this machine stands in for every pod (the
// controller's test seam, NODE_ENV=test), driving the fake ACP agent, as in pod-agent-auth.test.ts.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const KEY = 'sign-in-scope-bridge-key-0123456789';
const here = new URL('.', import.meta.url).pathname;
const bridgeRequire = createRequire(join(here, '..', '..', '..', '..', 'tools', 'agent-bridge', 'package.json'));
const FAKE_CLI = join(here, '..', '..', '..', '..', 'tools', 'fake-acp-agent', 'src', 'cli.ts');
const TSX = bridgeRequire.resolve('tsx/esm');
const PASS = ['FAKE_ACP_SCRIPT_JSON', 'FAKE_ACP_FLAVOR', 'FAKE_ACP_STATE_DIR'];

const saved: Record<string, string | undefined> = {};
const ENV = ['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL', 'MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL', 'MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY', 'FAKE_ACP_SCRIPT_JSON', 'FAKE_ACP_FLAVOR', 'FAKE_ACP_STATE_DIR'];
let w: World;
let bridge: Bridge;
let k8s: FakeK8s;
let dir: string;
let n = 0;

const profile = (agent: string, name: string) => ({ agent, driver: 'acp', workdir: join(dir, `work-${name}`), passEnv: PASS, acp: { command: process.execPath, args: ['--import', TSX, FAKE_CLI] } });
const fake = (auth: Record<string, unknown>): void => {
  n += 1;
  process.env['FAKE_ACP_FLAVOR'] = 'codex';
  // a state folder per test, so a sign-in of one test does not carry into the next
  process.env['FAKE_ACP_STATE_DIR'] = join(dir, `fake-codex-${n}`);
  process.env['FAKE_ACP_SCRIPT_JSON'] = JSON.stringify({ flavor: 'codex', auth, scenarios: { hello: [{ do: 'text', text: 'hi' }] }, default: 'hello' });
};
const standIn = (url: string | null = null): void => {
  process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'] = url ?? bridge.url;
  process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'] = KEY;
};
/** A Codex pod runner for Engineering and Marketing (Engineering is served: the first team by slug while no bot is placed). */
const make = async (name: string, kind: 'codex_cli' | 'claude_cli' = 'codex_cli'): Promise<string> => {
  const res = await w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', { name, label: `Runner ${name}`, kind, teams: { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.runner.id as string;
};
const scope = (id: string, to: 'shared' | 'per_team', who = omar) => w.call<any>(who, 'PUT', `/api/admin/bot-runners/${id}/sign-in-scope`, { scope: to });
/** Straight to per team, for the tests whose subject is not the switch (the switch route allows 10 a minute per person). */
const perTeam = (id: string) => w.system((tx) => tx.query(`UPDATE app.bot_runners SET sign_in_scope = 'per_team', status = 'waiting_for_sign_in' WHERE id = $1::uuid`, [id]));
const auth = (id: string, tail = '') => `/api/admin/bot-runners/${id}/agent-auth${tail}`;
const row = async (id: string): Promise<any> => (await w.system((tx) => tx.query(`SELECT sign_in_scope, status FROM app.bot_runners WHERE id = $1::uuid`, [id]))).rows[0];
const listed = async (id: string): Promise<any> => (await w.call<{ items: any[] }>(omar, 'GET', '/api/admin/bot-runners')).body.items.find((r) => r.id === id);
/** A team signs in with the device code, and the page sees it end. */
const signTeamIn = async (id: string, team: string): Promise<void> => {
  const started = await w.call<any>(omar, 'POST', auth(id, '/login'), { methodId: 'chat-gpt-device-code', team });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const end = Date.now() + 20_000;
  for (;;) {
    const s = await w.call<any>(omar, 'GET', `${auth(id)}?team=${team}`);
    if (s.body.auth?.state === 'signed_in') return;
    if (Date.now() > end) throw new Error(JSON.stringify(s.body));
    await new Promise((res) => setTimeout(res, 150));
  }
};
const stored = async (id: string): Promise<any[]> => (await w.system((tx) => tx.query(`SELECT team_id, state FROM app.bot_runner_team_signins WHERE runner_id = $1::uuid ORDER BY team_id`, [id]))).rows;

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'sign-in-scope-'));
  const config = parseConfig({ profiles: { codex: profile('codex', 'codex'), claude: profile('claude-code', 'claude') }, killGraceSeconds: 0.5 });
  bridge = await startBridge({ config, apiKey: KEY, stateDir: join(dir, 'state'), port: 0, log: () => undefined, tmpRoot: dir });
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] = k8s.url;
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w?.close();
  await bridge?.close();
  await k8s?.stop().catch(() => undefined);
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('the database keeps per team to Claude Code and Codex runners', () => {
  it('refuses per_team on an LLM gateway runner, a Hermes runner and a Hermes agent on a server, and takes it on a pod runner', async () => {
    const insert = (kind: string, extra = '') =>
      w
        .system((tx) => tx.query(`INSERT INTO app.bot_runners (workspace_id, name, label, kind, sign_in_scope${extra ? ', agent' : ''}) VALUES ($1, $2, 'X', $3, 'per_team'${extra ? `, '${extra}'` : ''})`, [omar.workspaceId, `db-${kind}-${extra || 'none'}`, kind]))
        .then(
          () => 'ok',
          (e: { code?: string }) => e.code,
        );
    expect(await insert('llm_gateway')).toBe('23514');
    expect(await insert('hermes_pod')).toBe('23514');
    expect(await insert('hermes_gateway', 'codex')).toBe('23514');
    expect(await insert('codex_cli')).toBe('ok');
    // an existing runner keeps the default: one sign-in for all its teams
    const id = await make('db-default');
    expect((await row(id)).sign_in_scope).toBe('shared');
    expect((await listed(id))).toMatchObject({ signInScope: 'shared', teamsSignedIn: null, teamsServed: null });
  });
});

describe('PUT /api/admin/bot-runners/:id/sign-in-scope', () => {
  it('is for a workspace admin only, and refuses a runner with no such choice', async () => {
    const id = await make('scope-who');
    expect((await scope(id, 'per_team', nadia)).status).toBe(403);
    const llm = await w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', { name: 'scope-llm', label: 'LLM', kind: 'llm_gateway', modelAlias: 'smart' });
    expect(llm.status, JSON.stringify(llm.body)).toBe(201);
    const r = await scope(llm.body.runner.id, 'per_team');
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe('Only a Claude Code or Codex runner can have a sign-in for each team.');
    expect((await row(id)).sign_in_scope).toBe('shared');
  });

  it('shared -> per team: signs the one sign-in out first, writes and audits the change, and the runner waits for its teams', async () => {
    standIn();
    fake({ signedIn: true });
    const id = await make('scope-switch');
    expect((await w.call<any>(omar, 'GET', auth(id))).body.auth.state).toBe('signed_in');
    const r = await scope(id, 'per_team');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.runner).toMatchObject({ signInScope: 'per_team', status: 'waiting_for_sign_in', uploadedAt: null });
    // signed out for real, through the bridge
    expect((await w.call<any>(omar, 'GET', `${auth(id)}?team=engineering`)).body.auth.state).toBe('signed_out');
    expect(await row(id)).toMatchObject({ sign_in_scope: 'per_team', status: 'waiting_for_sign_in' });
    const events = (await w.system((tx) => tx.query<{ payload: any }>(`SELECT payload FROM app.events WHERE type = 'bot_runner.sign_in_scope.changed' ORDER BY id`))).rows.map((x) => x.payload);
    expect(events.at(-1)).toMatchObject({ runnerId: id, from: 'shared', to: 'per_team', signedOut: 1, actorId: omar.actorId });
    // the same scope again changes nothing and audits nothing
    expect((await scope(id, 'per_team')).status).toBe(200);
    expect((await w.system((tx) => tx.query(`SELECT 1 FROM app.events WHERE type = 'bot_runner.sign_in_scope.changed' AND payload ->> 'runnerId' = $1`, [id]))).rows).toHaveLength(1);
    // the list says how many of its teams are signed in
    expect(await listed(id)).toMatchObject({ signInScope: 'per_team', teamsSignedIn: 0, teamsServed: 1 });
  });

  it('puts the column back and answers a plain sentence when a pod does not answer the sign-out', async () => {
    standIn('http://127.0.0.1:9');
    const id = await make('scope-dead');
    const r = await scope(id, 'per_team');
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe(`The Codex sign-in of Runner scope-dead could not be signed out, so nothing was changed. Wait a minute for the pod to answer, then try again.`);
    expect(JSON.stringify(r.body)).not.toContain('127.0.0.1');
    expect((await row(id)).sign_in_scope).toBe('shared');
  });
});

describe('the agent-auth routes with a team', () => {
  it('requires the team on a per-team runner, refuses it on a shared one, and refuses a team the runner does not serve', async () => {
    standIn();
    fake({ signedIn: false });
    const shared = await make('team-param-shared');
    const bad = await w.call<any>(omar, 'GET', `${auth(shared)}?team=engineering`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('This runner has one sign-in for all its teams, so no team is chosen here.');
    expect((await w.call<any>(omar, 'POST', auth(shared, '/login'), { methodId: 'chat-gpt-device-code', team: 'engineering' })).status).toBe(400);

    const id = await make('team-param');
    await perTeam(id);
    const none = await w.call<any>(omar, 'GET', auth(id));
    expect(none.status).toBe(400);
    expect(none.body.error.message).toBe('Each team of this runner signs in on its own. Choose the team to sign in.');
    const other = await w.call<any>(omar, 'GET', `${auth(id)}?team=customer-support`);
    expect(other.status).toBe(400);
    expect(other.body.error.message).toBe('That team is not one of the teams this runner serves.');
    expect((await w.call<any>(omar, 'GET', `${auth(id)}?team=no-such-team`)).status).toBe(400);
    expect((await w.call<any>(omar, 'POST', auth(id, '/logout'), {})).status).toBe(400);
    expect((await w.call<any>(nadia, 'GET', `${auth(id)}?team=engineering`)).status).toBe(403);
  });

  it("signs one team in: its state is stored, the runner turns ready, the list counts it, and the team list shows it; the audit line names the team", async () => {
    standIn();
    fake({ signedIn: false, url: 'https://auth.example.test/device', deviceCode: 'TEAM-12345', pendingMs: 600 });
    const id = await make('team-login');
    await perTeam(id);
    await signTeamIn(id, 'engineering');
    expect(await stored(id)).toEqual([{ team_id: TEAM_IDS.Engineering, state: 'signed_in' }]);
    expect((await row(id)).status).toBe('ready');
    expect(await listed(id)).toMatchObject({ teamsSignedIn: 1, teamsServed: 1 });
    const teams = await w.call<any>(omar, 'GET', auth(id, '/teams'));
    expect(teams.status, JSON.stringify(teams.body)).toBe(200);
    expect(teams.body.items.map((t: any) => [t.slug, t.served, t.state])).toEqual([
      ['engineering', true, 'signed_in'],
      ['marketing', false, null],
    ]);
    const line = (await w.system((tx) => tx.query<{ payload: any }>(`SELECT payload FROM app.events WHERE type = 'bot_runner.agent_auth.changed' AND payload ->> 'runnerId' = $1 ORDER BY id LIMIT 1`, [id]))).rows[0]!.payload;
    expect(line).toMatchObject({ change: 'login_started', teamId: TEAM_IDS.Engineering });

    // signing the team out: stored, and with no team signed in the runner waits again
    const out = await w.call<any>(omar, 'POST', auth(id, '/logout'), { team: 'engineering' });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await stored(id)).toEqual([{ team_id: TEAM_IDS.Engineering, state: 'signed_out' }]);
    expect((await row(id)).status).toBe('waiting_for_sign_in');
  });

  it('the team list is for a per-team runner only, and an upload of a sign-in file is refused there', async () => {
    const id = await make('team-list');
    expect((await w.call<any>(omar, 'GET', auth(id, '/teams'))).status).toBe(400);
    standIn();
    fake({ signedIn: false });
    await perTeam(id);
    const up = await fetch(`${w.server.url}/api/admin/bot-runners/${id}/credentials`, {
      method: 'PUT',
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: omar.actorId, workspaceId: omar.workspaceId }), 'content-type': 'application/json', 'x-terms-accepted': '1', 'x-signins-ack': '1' },
      body: '{}',
    });
    expect(up.status).toBe(409);
    expect(((await up.json()) as any).error.message).toContain('cannot be uploaded');
  });

  it('per team -> shared: every team that holds a sign-in is signed out through its pod, its stored state goes, and the runner needs one sign-in', async () => {
    standIn();
    fake({ signedIn: false, url: 'https://auth.example.test/device', deviceCode: 'BACK-12345', pendingMs: 300 });
    const id = await make('scope-back');
    expect((await scope(id, 'per_team')).status).toBe(200);
    await signTeamIn(id, 'engineering');
    expect(await stored(id)).toEqual([{ team_id: TEAM_IDS.Engineering, state: 'signed_in' }]);
    const r = await scope(id, 'shared');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.runner).toMatchObject({ signInScope: 'shared', teamsSignedIn: null, status: 'waiting_for_sign_in' });
    expect(await stored(id)).toEqual([]);
    const events = (await w.system((tx) => tx.query<{ payload: any }>(`SELECT payload FROM app.events WHERE type = 'bot_runner.sign_in_scope.changed' AND payload ->> 'runnerId' = $1 ORDER BY id`, [id]))).rows.map((x) => x.payload);
    expect(events.at(-1)).toMatchObject({ from: 'per_team', to: 'shared', signedOut: 1 });
    expect((await w.call<any>(omar, 'GET', auth(id))).body.auth.state).toBe('signed_out');
  });
});

// Last in the file: it stops the stand-in Kubernetes API.
describe('a switch the cluster refuses', () => {
  it('leaves the column and every stored team state as they were (the states are cleared in the switch\'s own transaction)', async () => {
    standIn();
    fake({ signedIn: false });
    const id = await make('scope-refused');
    await perTeam(id);
    await w.system((tx) => tx.query(`INSERT INTO app.bot_runner_team_signins (runner_id, team_id, state) VALUES ($1, $2, 'signed_out')`, [id, TEAM_IDS.Engineering]));
    await k8s.stop();
    const r = await scope(id, 'shared');
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('The cluster did not remove the old sign-in, so nothing was changed. Try again in a moment.');
    expect((await row(id)).sign_in_scope).toBe('per_team');
    expect(await stored(id)).toEqual([{ team_id: TEAM_IDS.Engineering, state: 'signed_out' }]);
    expect((await w.system((tx) => tx.query(`SELECT 1 FROM app.events WHERE type = 'bot_runner.sign_in_scope.changed' AND payload ->> 'runnerId' = $1 AND payload ->> 'to' = 'shared'`, [id]))).rows).toHaveLength(0);
  });
});
