/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../../../tools/agent-bridge/src/config.ts';
import { startBridge, type Bridge } from '../../../../tools/agent-bridge/src/server.ts';
import { createWorld, personas, type World } from './world.ts';

// P25-09: signing a bridge runner's agent in and out from the Runners page. A real bridge runs the fake ACP agent (tools/fake-acp-agent, never a real adapter, never the host's
// own ~/.claude or ~/.codex: its state is a scratch folder); the server is a proxy to it for a workspace admin only, and a code or key is in no answer, no event, no log line.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const KEY = 'agent-auth-bridge-key-0123456789';
const here = new URL('.', import.meta.url).pathname;
const bridgeRequire = createRequire(join(here, '..', '..', '..', '..', 'tools', 'agent-bridge', 'package.json'));
const FAKE_CLI = join(here, '..', '..', '..', '..', 'tools', 'fake-acp-agent', 'src', 'cli.ts');
const TSX = bridgeRequire.resolve('tsx/esm');
const PASS = ['FAKE_ACP_SCRIPT_JSON', 'FAKE_ACP_FLAVOR', 'FAKE_ACP_STATE_DIR'];

const saved: Record<string, string | undefined> = {};
const ENV = ['MANYTHREADS_AGENT_AUTH_WAIT_SCALE', 'MANYTHREADS_HERMES_ALLOWED_HOSTS', 'FAKE_ACP_SCRIPT_JSON', 'FAKE_ACP_FLAVOR', 'FAKE_ACP_STATE_DIR'];
let w: World;
let bridge: Bridge;
let dir: string;
let notBridge: Server;
let notBridgeUrl: string;
const logs: string[] = [];

const profile = (agent: string, name: string) => ({
  agent,
  driver: 'acp',
  workdir: join(dir, `work-${name}`),
  passEnv: PASS,
  acp: { command: process.execPath, args: ['--import', TSX, FAKE_CLI] },
});
/** The fake agent's script for the bridge's next child processes. It is read from the environment when a child starts, so each test sets what it needs. */
const fake = (flavor: string, auth: Record<string, unknown>): void => {
  process.env['FAKE_ACP_FLAVOR'] = flavor;
  process.env['FAKE_ACP_STATE_DIR'] = join(dir, `fake-${flavor}`);
  process.env['FAKE_ACP_SCRIPT_JSON'] = JSON.stringify({ flavor, auth, scenarios: { hello: [{ do: 'text', text: 'hi' }] }, default: 'hello' });
};
const make = async (name: string, agent: string, url = bridge.url, extra: Record<string, unknown> = {}) => {
  const res = await w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', { name, label: name, kind: 'hermes_gateway', baseUrl: url, apiKey: KEY, agent, teams: { all: true }, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.runner.id as string;
};
const auth = (id: string, tail = '') => `/api/admin/bot-runners/${id}/agent-auth${tail}`;
const eventsOf = () => w.system(async (tx) => (await tx.query<{ payload: any }>(`SELECT payload FROM app.events WHERE type = 'bot_runner.agent_auth.changed' ORDER BY id`)).rows.map((r) => r.payload));
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
  process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = '127.0.0.1';
  dir = mkdtempSync(join(tmpdir(), 'agent-auth-'));
  const config = parseConfig({
    profiles: { claude: profile('claude-code', 'claude'), codex: profile('codex', 'codex') },
    killGraceSeconds: 0.5,
  });
  bridge = await startBridge({ config, apiKey: KEY, stateDir: join(dir, 'state'), port: 0, log: (l) => logs.push(l), tmpRoot: dir });
  notBridge = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>hello</html>');
  });
  await new Promise<void>((resolve) => notBridge.listen(0, '127.0.0.1', resolve));
  notBridgeUrl = `http://127.0.0.1:${(notBridge.address() as AddressInfo).port}`;
  for (const m of ['log', 'warn', 'error', 'info'] as const) {
    const orig = console[m].bind(console);
    console[m] = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
      orig(...a);
    };
  }
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w?.close();
  await bridge?.close();
  await new Promise<void>((resolve) => (notBridge ? notBridge.close(() => resolve()) : resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('who and what', () => {
  it('only a workspace admin may use the routes; a team member is told no', async () => {
    fake('codex', { signedIn: false });
    const id = await make('who-codex', 'codex');
    expect((await w.call(nadia, 'GET', auth(id))).status).toBe(403);
    expect((await w.call(nadia, 'POST', auth(id, '/login'), { methodId: 'chat-gpt-device-code' })).status).toBe(403);
    expect((await w.call(nadia, 'POST', auth(id, '/answer'), { attemptId: 'x', code: 'abc' })).status).toBe(403);
    expect((await w.call(nadia, 'POST', auth(id, '/logout'))).status).toBe(403);
    expect((await w.call(null, 'GET', auth(id))).status).toBeGreaterThanOrEqual(401);
  });

  it('refuses a runner that is not an agent bridge, one with no key set, and answers plainly when the address is not a bridge', async () => {
    const hermes = await make('who-hermes', 'hermes');
    const refused = await w.call<any>(omar, 'GET', auth(hermes));
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('agent bridge');
    const pod = await w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', { name: 'who-llm', label: 'x', kind: 'llm_gateway', modelAlias: 'smart' });
    expect((await w.call(omar, 'GET', auth(pod.body.runner.id))).status).toBe(400);
    expect((await w.call(omar, 'GET', auth('00000000-0000-7000-8000-000000000000'))).status).toBe(404);
    const fakeBridge = await make('who-html', 'codex', notBridgeUrl);
    const unreadable = await w.call<any>(omar, 'GET', auth(fakeBridge));
    expect(unreadable.status).toBe(502);
    expect(JSON.stringify(unreadable.body)).toContain('cannot read');
    const wrongKey = await w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', { name: 'who-key', label: 'x', kind: 'hermes_gateway', baseUrl: bridge.url, apiKey: 'a-wrong-key-0123456789', agent: 'codex' });
    const refusedKey = await w.call<any>(omar, 'GET', auth(wrongKey.body.runner.id));
    expect(refusedKey.status).toBe(502);
    expect(JSON.stringify(refusedKey.body)).toContain('refused the key');
  });
});

describe('Codex: device code', () => {
  it('starts, shows the page and the code, finishes when the person is done, and signs out; the audit lines hold no code', async () => {
    fake('codex', { signedIn: false, url: 'https://auth.example.test/device', deviceCode: 'WXYZ-98765', pendingMs: 1500 });
    const id = await make('dc-codex', 'codex');
    const before = await w.call<{ auth: any }>(omar, 'GET', auth(id));
    expect(before.status).toBe(200);
    expect(before.body.auth).toMatchObject({ agent: 'codex', state: 'signed_out', attempt: null });
    expect(before.body.auth.methods.map((m: any) => m.id)).toContain('chat-gpt-device-code');

    const started = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/login'), { methodId: 'chat-gpt-device-code' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.attempt).toMatchObject({ state: 'waiting', action: { type: 'enter_code', url: 'https://auth.example.test/device', code: 'WXYZ-98765' } });
    const again = await w.call<any>(omar, 'POST', auth(id, '/login'), { methodId: 'chat-gpt-device-code' });
    expect(again.status).toBe(409);

    const after = await poll(id, (a) => a.attempt?.state === 'done');
    expect(after.state).toBe('signed_in');
    expect(JSON.stringify(after)).not.toContain('person@example.test');

    const out = await w.call<{ auth: any }>(omar, 'POST', auth(id, '/logout'));
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.auth).toMatchObject({ state: 'signed_out', attempt: null });

    const events = await eventsOf();
    const mine = events.filter((e) => e.name === 'dc-codex').map((e) => e.change);
    // the second start (refused with 409) left its line before the bridge was asked, and a second line saying it was refused
    expect(mine).toEqual(['login_started', 'login_started', 'login_started', 'login_succeeded', 'signed_out']);
    expect(JSON.stringify(events)).not.toContain('WXYZ');
    const auditRows = () => w.system(async (tx) => (await tx.query<{ action: string; reason: string | null }>("SELECT action, reason FROM app.audit_events WHERE action = 'bot_runner.agent_sign_in_changed' ORDER BY id")).rows);
    // the audit plugin makes the rows from the events, a moment later
    await expect.poll(async () => (await auditRows()).map((r) => r.reason), { timeout: 15_000 }).toEqual(expect.arrayContaining(['login started', 'login succeeded, device code', 'signed out']));
  });

  it('cancel ends a sign-in; a method the agent does not offer is refused', async () => {
    fake('codex', { signedIn: false, pendingMs: 60_000 });
    const id = await make('dc-cancel', 'codex');
    const started = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/login'), { methodId: 'chat-gpt-device-code' });
    const cancelled = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/cancel'), { attemptId: started.body.attempt.id });
    expect(cancelled.body.attempt.state).toBe('cancelled');
    expect((await w.call(omar, 'POST', auth(id, '/login'), { methodId: 'gateway' })).status).toBe(400);
    expect((await w.call(omar, 'POST', auth(id, '/cancel'), {})).status).toBe(404);
  });
});

describe('Codex: API key', () => {
  it('goes to the bridge once and is in no answer, no event, no log line', async () => {
    fake('codex', { signedIn: false });
    const id = await make('key-codex', 'codex');
    const started = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/login'), { methodId: 'api-key' });
    expect(started.body.attempt).toMatchObject({ state: 'needs_input', action: { type: 'give_key' } });
    const key = 'sk-test-SECRET-0123456789abcdef'; // secret-scan:ignore a made-up fixture
    expect((await w.call(omar, 'POST', auth(id, '/answer'), { attemptId: started.body.attempt.id, code: 'x', apiKey: key })).status).toBe(400);
    const answered = await w.call<any>(omar, 'POST', auth(id, '/answer'), { attemptId: started.body.attempt.id, apiKey: key });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(JSON.stringify(answered.body)).not.toContain(key);
    const done = await poll(id, (a) => a.attempt?.state === 'done');
    expect(done.state).toBe('signed_in');
    expect(JSON.stringify(await eventsOf())).not.toContain(key);
    expect(logs.join('\n')).not.toContain(key);
    await w.call(omar, 'POST', auth(id, '/logout'));
  });
});

describe('Claude: the pasted code', () => {
  it('shows the page the login program prints, takes the code, and signs in; the code is kept nowhere', async () => {
    fake('claude', { signedIn: false, url: 'https://claude.example.test/cai/oauth/authorize?code=true&client_id=fake' });
    const id = await make('paste-claude', 'claude-code');
    const status = await w.call<{ auth: any }>(omar, 'GET', auth(id));
    expect(status.body.auth.methods.map((m: any) => m.how)).toEqual(['paste_code', 'paste_code']);
    const started = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/login'), { methodId: 'claude-ai-login' });
    expect(started.body.attempt).toMatchObject({ state: 'needs_input', action: { type: 'paste_code', url: 'https://claude.example.test/cai/oauth/authorize?code=true&client_id=fake' } });
    const code = 'PASTED-CODE-xyz789#state9';
    const answered = await w.call<any>(omar, 'POST', auth(id, '/answer'), { attemptId: started.body.attempt.id, code });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const done = await poll(id, (a) => a.attempt?.state === 'done');
    expect(done).toMatchObject({ state: 'signed_in', kind: 'account' });
    expect(JSON.stringify(await eventsOf())).not.toContain('PASTED');
    expect(logs.join('\n')).not.toContain('PASTED');
    const out = await w.call<{ auth: any }>(omar, 'POST', auth(id, '/logout'));
    expect(out.body.auth.state).toBe('signed_out');
  });
});

describe('what the audit says, and when', () => {
  const linesOf = async (name: string) => (await eventsOf()).filter((e) => e.name === name);

  it('a sign-in that ends is audited once, when a page sees it end, with its kind and its outcome and no code; a wrong code is a failed one', async () => {
    fake('claude', { signedIn: false });
    const id = await make('audit-claude', 'claude-code');
    const started = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/login'), { methodId: 'claude-ai-login' });
    expect(started.body.attempt).toMatchObject({ how: 'paste_code', state: 'needs_input' });
    const wrong = 'WRONG-CODE-zzz999';
    const answered = await w.call<any>(omar, 'POST', auth(id, '/answer'), { attemptId: started.body.attempt.id, code: wrong });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const ended = await poll(id, (a) => a.attempt?.state === 'failed');
    expect(ended.attempt.message).toBe('The sign-in was refused. Check the code or key and start again.');
    await poll(id, (a) => a.attempt?.state === 'failed'); // a second look at the same ending
    const lines = await linesOf('audit-claude');
    expect(lines.map((e) => [e.change, e.how ?? null, e.answerKind ?? null, e.refused ?? null])).toEqual([
      ['login_started', null, null, null],
      ['answer_given', null, 'code', null],
      ['login_failed', 'paste_code', null, null],
    ]);
    expect(JSON.stringify(lines)).not.toContain('WRONG');
    expect(JSON.stringify(ended) + logs.join('\n')).not.toMatch(/person@example\.test|sk-ant-oat01/);
    // the audit plugin turns them into rows: the failed one is marked failed
    await expect.poll(async () => w.system(async (tx) => (await tx.query<{ reason: string | null; outcome: string | null }>("SELECT reason, outcome FROM app.audit_events WHERE action = 'bot_runner.agent_sign_in_changed' AND reason LIKE 'login failed%'")).rows), { timeout: 15_000 }).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'login failed, paste code', outcome: 'failed' })]),
    );
  });

  it('the line of a request is written before the bridge is asked, and a request the bridge refuses leaves a second line saying so', async () => {
    const html = await make('audit-html', 'codex', notBridgeUrl);
    const refused = await w.call<any>(omar, 'POST', auth(html, '/login'), { methodId: 'chat-gpt-device-code' });
    expect(refused.status).toBe(502);
    expect((await linesOf('audit-html')).map((e) => [e.change, e.refused ?? null])).toEqual([
      ['login_started', null],
      ['login_started', true],
    ]);
    fake('codex', { signedIn: false, pendingMs: 60_000 });
    const real = await make('audit-busy', 'codex');
    await w.call(omar, 'POST', auth(real, '/login'), { methodId: 'chat-gpt-device-code' });
    expect((await w.call(omar, 'POST', auth(real, '/login'), { methodId: 'chat-gpt-device-code' })).status).toBe(409);
    expect((await linesOf('audit-busy')).map((e) => [e.change, e.refused ?? null])).toEqual([
      ['login_started', null],
      ['login_started', null],
      ['login_started', true],
    ]);
    await w.call(omar, 'POST', auth(real, '/cancel'), {});
  });

  it('a bridge that does not answer in time is a plain 502 and a refused line; the wait is the scaled one', async () => {
    const slow = createServer(() => undefined);
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    process.env['MANYTHREADS_AGENT_AUTH_WAIT_SCALE'] = '0.03';
    try {
      const id = await make('audit-slow', 'codex', `http://127.0.0.1:${(slow.address() as AddressInfo).port}`);
      const started = Date.now();
      const out = await w.call<any>(omar, 'POST', auth(id, '/logout'));
      expect(out.status).toBe(502);
      expect(JSON.stringify(out.body)).toContain('did not answer');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect((await linesOf('audit-slow')).map((e) => [e.change, e.refused ?? null])).toEqual([
        ['signed_out', null],
        ['signed_out', true],
      ]);
    } finally {
      delete process.env['MANYTHREADS_AGENT_AUTH_WAIT_SCALE'];
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it('a person who is not an admin is told no before anything is read: a body that would be refused is a 403, not a 400', async () => {
    fake('codex', { signedIn: false });
    const id = await make('audit-who', 'codex');
    for (const [tail, body] of [['/login', { nonsense: 1 }], ['/answer', { code: 5 }], ['/cancel', { attemptId: 7 }]] as const) {
      expect((await w.call(nadia, 'POST', auth(id, tail), body)).status, tail).toBe(403);
      expect((await w.call(omar, 'POST', auth(id, tail), body)).status, tail).toBe(400);
    }
    expect(await linesOf('audit-who')).toEqual([]);
  });
});

describe('what the page is told about the sign-in', () => {
  it('whose sign-in it is (the profile, and the machine\'s shared folder or its own), the kind of attempt, and a long page address whole', async () => {
    const url = `https://claude.example.test/cai/oauth/authorize?code=true&state=${'q'.repeat(1400)}`;
    fake('claude', { signedIn: false, url });
    const id = await make('page-claude', 'claude-code');
    const status = await w.call<{ auth: any }>(omar, 'GET', auth(id));
    expect(status.body.auth).toMatchObject({ profile: 'claude', home: 'shared', state: 'signed_out' });
    const started = await w.call<{ attempt: any }>(omar, 'POST', auth(id, '/login'), { methodId: 'claude-ai-login' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.attempt).toMatchObject({ how: 'paste_code', action: { type: 'paste_code', url } });
    await w.call(omar, 'POST', auth(id, '/cancel'), {});
  });
});
