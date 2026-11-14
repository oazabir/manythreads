import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyMethod } from '../src/acp/auth.ts';
import { plainText, ptySupported } from '../src/acp/pty.ts';
import { acpHarness, type AcpHarness, type Flavor } from './acp-support.ts';
import { KEY } from './support.ts';

// Sign-in and sign-out through the bridge (P25-09), against the fake ACP agent: its device code, its API-key and terminal methods, its `auth/status` and `logout`, and its
// `--cli auth login --claudeai` program under a pseudo-terminal. The state lives in a scratch folder (`FAKE_ACP_STATE_DIR`); the host's own ~/.claude and ~/.codex are never touched.

let h: AcpHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Json; raw: string }> {
  const res = await fetch(`${h!.bridge.url}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const raw = await res.text();
  return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
}

const script = (flavor: Flavor, auth: Record<string, unknown>): Record<string, unknown> => ({ flavor, auth, scenarios: { hello: [{ do: 'text', text: 'hi' }] }, default: 'hello' });

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const authFile = (): Json | null => {
  try {
    return JSON.parse(readFileSync(join(h!.stateDir, 'auth.json'), 'utf8')) as Json;
  } catch {
    return null;
  }
};

describe('status', () => {
  it('claude: says signed out or in from the adapter, offers only the two terminal methods, and never forwards the account e-mail or organization', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false }) });
    const out = await api('GET', '/v1/auth/status?agent=claude-code');
    expect(out.status).toBe(200);
    expect(out.body['auth']).toMatchObject({ agent: 'claude-code', state: 'signed_out', canLogout: true, attempt: null, note: null });
    expect(out.body['auth'].methods.map((m: Json) => [m['id'], m['how']])).toEqual([
      ['claude-ai-login', 'paste_code'],
      ['console-login', 'paste_code'],
    ]);
    expect(out.body['auth'].methods[0]).toMatchObject({ name: 'Claude Subscription' });
  });

  it('claude signed in: the state and the kind, and not one word the adapter said about the account', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: true }) });
    const out = await api('GET', '/p/default/v1/auth/status');
    expect(out.body['auth']).toMatchObject({ state: 'signed_in', kind: 'account' });
    for (const secret of ['person@example.test', 'Example Org', 'Fake Subscription', 'max']) expect(out.raw).not.toContain(secret);
  });

  it('codex: the state comes from the adapter\'s own push after initialize; offers the device code and the key', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false }) });
    const out = await api('GET', '/v1/auth/status?agent=codex');
    expect(out.body['auth']).toMatchObject({ agent: 'codex', state: 'signed_out', canLogout: true });
    expect(out.body['auth'].methods.map((m: Json) => [m['id'], m['how']])).toEqual([
      ['api-key', 'api_key'],
      ['chat-gpt-device-code', 'device_code'],
    ]);
  });

  it('hermes: nothing to sign in, no methods, no sign-out', async () => {
    h = await acpHarness({ flavor: 'hermes' });
    const out = await api('GET', '/v1/auth/status?agent=hermes-acp');
    expect(out.body['auth']).toMatchObject({ state: 'not_needed', canLogout: false, methods: [], note: expect.stringContaining('model gateway') });
    expect((await api('POST', '/v1/auth/login', { methodId: 'custom' })).status).toBe(409);
    expect((await api('POST', '/v1/auth/logout')).status).toBe(409);
  });

  it('a request with no key is refused, a method of the wrong verb is refused, an unknown tool has no profile', async () => {
    h = await acpHarness({ flavor: 'codex' });
    expect((await fetch(`${h.bridge.url}/v1/auth/status`)).status).toBe(401);
    expect((await api('POST', '/v1/auth/status')).status).toBe(405);
    expect((await api('GET', '/v1/auth/login')).status).toBe(405);
    expect((await api('GET', '/v1/auth/status?agent=claude-code')).status).toBe(404);
  });
});

describe('Codex device code', () => {
  it('shows the page and the code from the adapter\'s message, waits, and is signed in when the person is done; then signs out', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false, url: 'https://auth.example.test/device', deviceCode: 'WXYZ-98765', pendingMs: 1200 }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'chat-gpt-device-code' });
    expect(started.status).toBe(200);
    expect(started.body['attempt']).toMatchObject({ methodId: 'chat-gpt-device-code', state: 'waiting', action: { type: 'enter_code', url: 'https://auth.example.test/device', code: 'WXYZ-98765' } });
    // the sign-in is under way: the status says so, without starting another adapter
    const during = await api('GET', '/v1/auth/status?agent=codex');
    expect(during.body['auth'].attempt).toMatchObject({ state: 'waiting' });
    const done = await until(
      async () => (await api('GET', '/v1/auth/status?agent=codex')).body['auth'].attempt,
      (a: Json) => a['state'] === 'done',
    );
    expect(done).toMatchObject({ state: 'done', action: null });
    expect(authFile()).toMatchObject({ signedIn: true });
    const after = await api('GET', '/v1/auth/status?agent=codex');
    expect(after.body['auth']).toMatchObject({ state: 'signed_in', kind: 'account' });
    expect(after.raw).not.toContain('person@example.test');

    const out = await api('POST', '/v1/auth/logout');
    expect(out.status).toBe(200);
    expect(out.body['auth']).toMatchObject({ state: 'signed_out', attempt: null });
    expect(authFile()).toMatchObject({ signedIn: false });
  }, 40_000);

  it('a second sign-in while one waits is refused, and cancel ends the wait and the adapter process', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false, pendingMs: 60_000 }) });
    const first = await api('POST', '/v1/auth/login', { methodId: 'chat-gpt-device-code' });
    const id = first.body['attempt'].id as string;
    const again = await api('POST', '/v1/auth/login', { methodId: 'chat-gpt-device-code' });
    expect(again.status).toBe(409);
    expect(again.body['error']['code']).toBe('sign_in_busy');
    expect((await api('POST', '/v1/auth/logout')).status).toBe(409);
    const cancelled = await api('POST', '/v1/auth/login/cancel', { attemptId: id });
    expect(cancelled.body['attempt']).toMatchObject({ state: 'cancelled', action: null });
    expect(authFile()).toBeNull();
    // a new one can start after
    const next = await api('POST', '/v1/auth/login', { methodId: 'chat-gpt-device-code' });
    expect(next.status).toBe(200);
    expect(next.body['attempt'].id).not.toBe(id);
    await api('POST', '/v1/auth/login/cancel', {});
  }, 40_000);

  it('a method the agent does not offer, and a gateway method, are refused', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false }) });
    expect((await api('POST', '/v1/auth/login', { methodId: 'gateway' })).status).toBe(400);
    expect((await api('POST', '/v1/auth/login', { methodId: 'chat-gpt' })).status).toBe(400);
    expect((await api('POST', '/v1/auth/login', {})).status).toBe(400);
  }, 40_000);
});

describe('an API key', () => {
  it('is asked for, passed to the adapter once, and is in no answer and no log line', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'api-key' });
    expect(started.body['attempt']).toMatchObject({ state: 'needs_input', action: { type: 'give_key' } });
    const id = started.body['attempt'].id as string;
    expect((await api('POST', '/v1/auth/login/answer', { attemptId: id, apiKey: 'short' })).status).toBe(400);
    expect((await api('POST', '/v1/auth/login/answer', { attemptId: id, code: '123' })).status).toBe(409);
    const key = 'sk-test-KEY-0123456789abcdef'; // secret-scan:ignore a made-up fixture
    const answered = await api('POST', '/v1/auth/login/answer', { attemptId: id, apiKey: key });
    expect(answered.status).toBe(200);
    expect(answered.raw).not.toContain(key);
    const done = await until(
      async () => (await api('GET', '/v1/auth/status?agent=codex')).body['auth'].attempt,
      (a: Json) => a['state'] === 'done',
    );
    expect(done['message']).toBe('Signed in.');
    expect(authFile()).toMatchObject({ signedIn: true });
    expect(h.logs.join('\n')).not.toContain(key);
  }, 40_000);
});

describe.skipIf(!ptySupported())('Claude terminal login under a pseudo-terminal', () => {
  it('shows the page the program prints, takes the pasted code, and is signed in; the code is in no answer', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false, url: 'https://claude.example.test/cai/oauth/authorize?code=true&client_id=fake' }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(started.status).toBe(200);
    expect(started.body['attempt']).toMatchObject({ state: 'needs_input', action: { type: 'paste_code', url: 'https://claude.example.test/cai/oauth/authorize?code=true&client_id=fake' } });
    const id = started.body['attempt'].id as string;
    const code = 'PASTED-CODE-abc123#state456';
    const answered = await api('POST', '/v1/auth/login/answer', { attemptId: id, code });
    expect(answered.raw).not.toContain(code);
    const done = await until(
      async () => (await api('GET', '/v1/auth/status?agent=claude-code')).body['auth'].attempt,
      (a: Json) => a['state'] === 'done',
    );
    expect(done).toMatchObject({ state: 'done', message: 'Signed in.' });
    expect(authFile()).toMatchObject({ signedIn: true });
    expect((await api('GET', '/v1/auth/status?agent=claude-code')).body['auth']).toMatchObject({ state: 'signed_in', kind: 'account' });
    expect(h.logs.join('\n')).not.toContain(code);
  }, 40_000);

  it('a program that is stopped before the code is given ends the attempt as failed, in plain words', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'console-login' });
    const id = started.body['attempt'].id as string;
    const cancelled = await api('POST', '/v1/auth/login/cancel', { attemptId: id });
    expect(cancelled.body['attempt']).toMatchObject({ state: 'cancelled', message: 'The sign-in was cancelled.' });
    expect((await api('POST', '/v1/auth/login/answer', { attemptId: id, code: 'abc' })).status).toBe(404);
    expect(authFile()).toBeNull();
  }, 40_000);

  it('signs out through the adapter\'s own logout', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: true }) });
    expect((await api('GET', '/v1/auth/status?agent=claude-code')).body['auth'].state).toBe('signed_in');
    const out = await api('POST', '/p/default/v1/auth/logout');
    expect(out.status).toBe(200);
    expect(out.body['auth']).toMatchObject({ state: 'signed_out' });
    expect(authFile()).toMatchObject({ signedIn: false });
  }, 40_000);
});

describe.skipIf(!ptySupported())('sign-out when the adapter has no logout', () => {
  it('claude: falls back to the adapter\'s own `--cli auth logout` program', async () => {
    h = await acpHarness({ flavor: 'claude', script: { ...script('claude', { signedIn: true }), faults: { noLogout: true } } });
    const out = await api('POST', '/v1/auth/logout');
    expect(out.status).toBe(200);
    expect(out.body['auth']).toMatchObject({ state: 'signed_out' });
    expect(authFile()).toMatchObject({ signedIn: false });
  }, 40_000);

  it('codex: no logout and no fallback is a plain refusal', async () => {
    h = await acpHarness({ flavor: 'codex', script: { ...script('codex', { signedIn: true }), faults: { noLogout: true } } });
    const out = await api('POST', '/v1/auth/logout');
    expect(out.status).toBe(409);
    expect(out.body['error']['message']).toContain('no sign-out');
  }, 40_000);
});

describe('helpers', () => {
  it('removes terminal colour and cursor codes and carriage returns', () => {
    const esc = String.fromCharCode(27);
    expect(plainText(`${esc}[1;32mvisit:${esc}[0m https://x.test/a\r\n${esc}]0;title${String.fromCharCode(7)}ok`)).toBe('visit: https://x.test/a\nok');
  });

  it('classifies only the ways a page can do: Claude\'s login terminal methods, Codex\'s device code and key', () => {
    expect(classifyMethod('claude', { id: 'a', type: 'terminal', args: ['--cli', 'auth', 'login', '--claudeai'] })).toBe('paste_code');
    expect(classifyMethod('claude', { id: 'gateway' })).toBeNull();
    expect(classifyMethod('claude', { id: 'x', type: 'terminal', args: ['--setup'] })).toBeNull();
    expect(classifyMethod('codex', { id: 'chat-gpt-device-code' })).toBe('device_code');
    expect(classifyMethod('codex', { id: 'chat-gpt' })).toBeNull();
    expect(classifyMethod('hermes', { id: 'custom' })).toBeNull();
  });
});
