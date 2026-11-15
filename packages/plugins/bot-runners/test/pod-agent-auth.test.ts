/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../../../tools/agent-bridge/src/config.ts';
import { startBridge, type Bridge } from '../../../../tools/agent-bridge/src/server.ts';
import { createWorld, personas, type World } from './world.ts';

// P26-10: a pod runner (Claude Code or Codex in a pod) is signed in from the Runners page through the same routes as a bridge runner. The pod's bridge is inside the cluster, so the server
// finds its address and key through the claude-pods controller; here a real bridge on this machine stands in for the pod (the controller's test seam, NODE_ENV=test), driving the fake ACP agent.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const KEY = 'pod-agent-auth-bridge-key-0123456789';
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

const profile = (agent: string, name: string) => ({ agent, driver: 'acp', workdir: join(dir, `work-${name}`), passEnv: PASS, acp: { command: process.execPath, args: ['--import', TSX, FAKE_CLI] } });
const fake = (flavor: string, auth: Record<string, unknown>): void => {
  process.env['FAKE_ACP_FLAVOR'] = flavor;
  process.env['FAKE_ACP_STATE_DIR'] = join(dir, `fake-${flavor}`);
  process.env['FAKE_ACP_SCRIPT_JSON'] = JSON.stringify({ flavor, auth, scenarios: { hello: [{ do: 'text', text: 'hi' }] }, default: 'hello' });
};
const make = async (name: string, kind: 'claude_cli' | 'codex_cli'): Promise<string> => {
  const res = await w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', { name, label: name, kind, teams: { all: true } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.runner.id as string;
};
const setStatus = (id: string, status: string): Promise<unknown> => w.system((tx) => tx.query(`UPDATE app.bot_runners SET status = $2 WHERE id = $1::uuid`, [id, status]));
const statusOf = async (id: string): Promise<string> => (await w.system((tx) => tx.query<{ status: string }>(`SELECT status FROM app.bot_runners WHERE id = $1::uuid`, [id]))).rows[0]!.status;
const auth = (id: string, tail = '') => `/api/admin/bot-runners/${id}/agent-auth${tail}`;
const poll = async (id: string, ok: (a: any) => boolean): Promise<any> => {
  const end = Date.now() + 20_000;
  for (;;) {
    const r = await w.call<{ auth: any }>(omar, 'GET', auth(id));
    if (ok(r.body.auth)) return r.body.auth;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(r.body).slice(0, 300)}`);
    await new Promise((res) => setTimeout(res, 150));
  }
};

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'pod-agent-auth-'));
  const config = parseConfig({ profiles: { claude: profile('claude-code', 'claude'), codex: profile('codex', 'codex') }, killGraceSeconds: 0.5 });
  bridge = await startBridge({ config, apiKey: KEY, stateDir: join(dir, 'state'), port: 0, log: () => undefined, tmpRoot: dir });
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] = k8s.url;
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w?.close();
  await bridge?.close();
  await k8s?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const standIn = (on: boolean): void => {
  if (on) {
    process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'] = bridge.url;
    process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'] = KEY;
  } else {
    delete process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'];
    delete process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'];
  }
};

describe('a Codex pod runner', () => {
  it('signs in with the device code from the page, and the runner turns ready once the page has seen the bridge say signed in', async () => {
    standIn(true);
    fake('codex', { signedIn: false, url: 'https://auth.example.test/device', deviceCode: 'POD-98765', pendingMs: 1200 });
    const id = await make('pod-codex', 'codex_cli');
    await setStatus(id, 'waiting_for_sign_in');
    const before = await w.call<{ auth: any }>(omar, 'GET', auth(id));
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.auth).toMatchObject({ agent: 'codex', state: 'signed_out' });
    expect(await statusOf(id)).toBe('waiting_for_sign_in');

    const started = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/login'), { methodId: 'chat-gpt-device-code' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.attempt).toMatchObject({ state: 'waiting', action: { type: 'enter_code', code: 'POD-98765' } });
    const done = await poll(id, (a) => a.state === 'signed_in');
    expect(done.state).toBe('signed_in');
    expect(await statusOf(id)).toBe('ready');

    const out = await w.call<{ auth: any }>(omar, 'POST', auth(id, '/logout'));
    expect(out.body.auth.state).toBe('signed_out');
    // signing out is seen by the page at once: the runner waits for a sign-in again
    expect(await statusOf(id)).toBe('waiting_for_sign_in');
  });

  it('does not touch a runner that is paused or off when the bridge says signed in', async () => {
    standIn(true);
    fake('codex', { signedIn: true });
    const id = await make('pod-codex-off', 'codex_cli');
    await setStatus(id, 'paused');
    await w.call(omar, 'GET', auth(id));
    expect(await statusOf(id)).toBe('paused');
  });
});

describe('a Claude Code pod runner', () => {
  it('signs in with a pasted code, which is kept nowhere', async () => {
    standIn(true);
    fake('claude', { signedIn: false, url: 'https://claude.example.test/cai/oauth/authorize?code=true&client_id=fake' });
    const id = await make('pod-claude', 'claude_cli');
    const status = await w.call<{ auth: any }>(omar, 'GET', auth(id));
    expect(status.body.auth).toMatchObject({ agent: 'claude-code', state: 'signed_out' });
    const started = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/login'), { methodId: 'claude-ai-login' });
    expect(started.body.attempt).toMatchObject({ state: 'needs_input', action: { type: 'paste_code' } });
    const code = 'POD-PASTED-CODE-abc123#state';
    const answered = await w.call<any>(omar, 'POST', auth(id, '/answer'), { attemptId: started.body.attempt.id, code });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(JSON.stringify(answered.body)).not.toContain(code);
    expect((await poll(id, (a) => a.attempt?.state === 'done')).state).toBe('signed_in');
    await w.call(omar, 'POST', auth(id, '/logout'));
  });
});

describe('who may, and when there is no pod', () => {
  it('is for a workspace admin only', async () => {
    standIn(true);
    fake('codex', { signedIn: false });
    const id = await make('pod-who', 'codex_cli');
    expect((await w.call(nadia, 'GET', auth(id))).status).toBe(403);
    expect((await w.call(nadia, 'POST', auth(id, '/login'), { methodId: 'chat-gpt-device-code' })).status).toBe(403);
    expect((await w.call(nadia, 'POST', auth(id, '/logout'))).status).toBe(403);
  });

  it('says plainly that the pod is not there yet when the controller has no key for it, and never shows the address or the key', async () => {
    standIn(false);
    const id = await make('pod-none', 'codex_cli');
    const r = await w.call<any>(omar, 'GET', auth(id));
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('no pod yet');
    expect(JSON.stringify(r.body)).not.toContain('8650');
  });

  it('answers plainly when the pod does not answer, with no address in the words', async () => {
    process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'] = 'http://127.0.0.1:9';
    process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'] = KEY;
    const id = await make('pod-dead', 'codex_cli');
    const r = await w.call<any>(omar, 'GET', auth(id));
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toContain('did not answer');
    expect(JSON.stringify(r.body)).not.toContain('127.0.0.1');
  });
});
