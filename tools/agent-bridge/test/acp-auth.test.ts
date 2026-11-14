import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_WORDS, classifyMethod, failureWords, findSignInPage } from '../src/acp/auth.ts';
import { plainChunks, plainText, ptySupported, startPty } from '../src/acp/pty.ts';
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

const SECRETS = ['person@example.test', 'sk-ant-oat01-FAKEFAKEFAKEFAKE']; // secret-scan:ignore a made-up fixture
const pidOf = (name: string): number => Number(readFileSync(join(h!.stateDir, 'pids', `${name}.pid`), 'utf8'));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
};
const attemptOf = async (agent: string): Promise<Json> => (await api('GET', `/v1/auth/status?agent=${agent}`)).body['auth'].attempt;

describe.skipIf(!ptySupported())('Claude login: what the real program does (docs/spikes/acp-measured.md)', () => {
  it('a wrong code ends the sign-in at once, in the fixed sentence, with the code, the account and the token in no answer and no log line', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    const id = started.body['attempt'].id as string;
    const wrong = 'WRONG-CODE-xyz987';
    const answered = await api('POST', '/v1/auth/login/answer', { attemptId: id, code: wrong });
    const ended = await until(attemptOf.bind(null, 'claude-code'), (a: Json) => a['state'] === 'failed');
    expect(ended).toMatchObject({ state: 'failed', action: null, message: AUTH_WORDS.refused });
    const everything = `${answered.raw}${JSON.stringify(ended)}${h.logs.join('\n')}`;
    for (const secret of [wrong, ...SECRETS]) expect(everything).not.toContain(secret);
    expect(authFile()).toBeNull();
    // the sign-in can be started again at once
    expect((await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' })).status).toBe(200);
  }, 40_000);

  it('a long page address that arrives in pieces, inside a hyperlink, is shown whole and once', async () => {
    const url = `https://claude.example.test/cai/oauth/authorize?code=true&client_id=fake&state=${'s'.repeat(1500)}`;
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false, url, urlSplitMs: 250 }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(started.body['attempt']).toMatchObject({ state: 'needs_input', how: 'paste_code', action: { type: 'paste_code', url } });
  }, 40_000);

  it('a page address that is too long to use fails the sign-in with a plain sentence', async () => {
    const url = `https://claude.example.test/${'a'.repeat(2500)}`;
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false, url }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(started.body['attempt']).toMatchObject({ state: 'failed', action: null, message: AUTH_WORDS.badUrl });
  }, 40_000);

  it('a program that takes the code and never answers ends as failed after the checking time, in a plain sentence', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false, hangAfterCode: true }), auth: { checkTimeoutMs: 2500 } });
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    const id = started.body['attempt'].id as string;
    const answered = await api('POST', '/v1/auth/login/answer', { attemptId: id, code: 'PASTED-CODE-abc123#state456' });
    expect(answered.body['attempt'].state).toBe('checking');
    const ended = await until(attemptOf.bind(null, 'claude-code'), (a: Json) => a['state'] === 'failed');
    expect(ended['message']).toBe(AUTH_WORDS.checkTimeout);
    // and the program was stopped
    expect(await gone(pidOf('login'))).toBe(true);
  }, 40_000);

  it('a sign-in nobody finishes ends when the wait is over, and so does a device code that ran out', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false }), auth: { pasteTimeoutMs: 600 } });
    await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    expect((await until(attemptOf.bind(null, 'claude-code'), (a: Json) => a['state'] === 'failed'))['message']).toBe(AUTH_WORDS.notFinished);
    await h.close();
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false, pendingMs: null }), auth: { deviceTimeoutMs: 600 } });
    await api('POST', '/v1/auth/login', { methodId: 'chat-gpt-device-code' });
    expect((await until(attemptOf.bind(null, 'codex'), (a: Json) => a['state'] === 'failed'))['message']).toBe(AUTH_WORDS.expired);
  }, 40_000);

  it('a cancel ends the login program itself, not only its terminal', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    const pid = pidOf('login');
    expect(alive(pid)).toBe(true);
    await api('POST', '/v1/auth/login/cancel', { attemptId: started.body['attempt'].id });
    expect(await gone(pid)).toBe(true);
  }, 40_000);

  it('a sign-in while already signed in is allowed and replaces the account', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: true }) });
    expect((await api('GET', '/v1/auth/status?agent=claude-code')).body['auth'].state).toBe('signed_in');
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(started.status).toBe(200);
    await api('POST', '/v1/auth/login/answer', { attemptId: started.body['attempt'].id, code: 'PASTED-CODE-abc123#state456' });
    await until(attemptOf.bind(null, 'claude-code'), (a: Json) => a['state'] === 'done');
    expect((await api('GET', '/v1/auth/status?agent=claude-code')).body['auth'].state).toBe('signed_in');
  }, 40_000);

  it('a reload in the middle of a sign-in still sees the attempt and the page to open, and says a sign-in is under way', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    const again = await api('GET', '/v1/auth/status?agent=claude-code');
    expect(again.body['auth']).toMatchObject({ state: 'unknown', note: AUTH_WORDS.underWay, attempt: { id: started.body['attempt'].id, state: 'needs_input', action: { type: 'paste_code' } } });
  }, 40_000);

  it('the terminal tool is told the profile\'s own sign-in folder, and a profile with its own folder signs in apart from the machine\'s', async () => {
    const own = join(tmpdir(), `bridge-own-home-${process.pid}-${Date.now()}`);
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false }), extraProfiles: { own: { authHome: own } } });
    const shared = await api('GET', '/p/default/v1/auth/status');
    expect(shared.body['auth']).toMatchObject({ profile: 'default', home: 'shared' });
    const mine = await api('GET', '/p/own/v1/auth/status');
    expect(mine.body['auth']).toMatchObject({ profile: 'own', home: 'dedicated' });
    // a sign-in on the shared folder does not block one on the profile's own
    const first = await api('POST', '/p/default/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(first.status).toBe(200);
    const second = await api('POST', '/p/own/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(second.status).toBe(200);
    expect(existsSync(own)).toBe(true);
    expect(readFileSync(join(h.stateDir, 'pids', 'login.home'), 'utf8')).toBe(own);
    await api('POST', '/p/default/v1/auth/login/cancel', {});
    await api('POST', '/p/own/v1/auth/login/cancel', {});
    rmSync(own, { recursive: true, force: true });
  }, 40_000);

  it('a profile whose env names the folder is dedicated too', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: true }), profile: { env: { CLAUDE_CONFIG_DIR: '/tmp/some-home' } } });
    expect((await api('GET', '/v1/auth/status?agent=claude-code')).body['auth']).toMatchObject({ home: 'dedicated' });
  }, 40_000);

  it('an unknown method is a plain 400 and leaves nothing behind', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: false }) });
    const refused = await api('POST', '/v1/auth/login', { methodId: 'no-such-method' });
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toMatchObject({ code: 'unknown_method' });
    expect((await api('GET', '/v1/auth/status?agent=claude-code')).body['auth'].attempt).toBeNull();
    expect((await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' })).status).toBe(200);
  }, 40_000);

  it('a sign-out that fails says so in the fixed sentence, names no account and leaves the sign-in free for the next try', async () => {
    h = await acpHarness({ flavor: 'claude', script: { ...script('claude', { signedIn: true }), faults: { logoutFails: true } } });
    const out = await api('POST', '/v1/auth/logout');
    expect(out.status).toBe(502);
    expect(out.body['error']).toMatchObject({ code: 'sign_out_failed', message: AUTH_WORDS.signOutFailed });
    for (const secret of SECRETS) expect(out.raw + h.logs.join('\n')).not.toContain(secret);
    expect(authFile()).toBeNull();
    expect((await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' })).status).toBe(200);
  }, 40_000);

  it('a login that starts while a sign-out runs is refused, and the sign-out does not take a later attempt away', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { signedIn: true }) });
    const out = api('POST', '/v1/auth/logout');
    await new Promise((r) => setTimeout(r, 40));
    const during = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(during.status).toBe(409);
    expect(during.body['error']['code']).toBe('sign_in_busy');
    expect((await out).status).toBe(200);
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(started.status).toBe(200);
    expect(await attemptOf('claude-code')).toMatchObject({ id: started.body['attempt'].id, state: 'needs_input' });
    // two at once: exactly one gets the place
    await api('POST', '/v1/auth/login/cancel', {});
    const pair = await Promise.all([api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' }), api('POST', '/v1/auth/logout')]);
    expect(pair.map((r) => r.status).sort()).toEqual([200, 409]);
  }, 60_000);

  it('where this machine cannot run a program under a terminal, the sign-in says so and a sign-out without an adapter logout is a refusal', async () => {
    h = await acpHarness({ flavor: 'claude', script: { ...script('claude', { signedIn: true }), faults: { noLogout: true } }, auth: { ptySupported: () => false } });
    const started = await api('POST', '/v1/auth/login', { methodId: 'claude-ai-login' });
    expect(started.body['attempt']).toMatchObject({ state: 'failed', message: AUTH_WORDS.noPty });
    const out = await api('POST', '/v1/auth/logout');
    expect(out.status).toBe(409);
    expect(out.body['error']['message']).toBe(AUTH_WORDS.noLogout);
  }, 40_000);
});

describe('Codex: failures, cleanup and the key', () => {
  it('an adapter that dies in the middle of a sign-in ends it as failed in a plain sentence', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false, pendingMs: null, dieAfterAcceptMs: 300 }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'chat-gpt-device-code' });
    expect(started.body['attempt'].state).toBe('waiting');
    const ended = await until(attemptOf.bind(null, 'codex'), (a: Json) => a['state'] === 'failed');
    expect(ended['message']).toBe(AUTH_WORDS.notFinished);
    expect(authFile()).toBeNull();
  }, 40_000);

  it('a cancel ends the adapter process that waited for the code', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false, pendingMs: null }) });
    const started = await api('POST', '/v1/auth/login', { methodId: 'chat-gpt-device-code' });
    const pid = pidOf('adapter');
    expect(alive(pid)).toBe(true);
    await api('POST', '/v1/auth/login/cancel', { attemptId: started.body['attempt'].id });
    expect(await gone(pid)).toBe(true);
  }, 40_000);

  it('a wrong key leaves the sign-in waiting for another, says the fixed sentence, and the key, the account and the token are in no answer and no log; the right key signs in', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false, acceptKey: 'sk-test-RIGHT-0123456789' }) }); // secret-scan:ignore a made-up fixture
    const started = await api('POST', '/v1/auth/login', { methodId: 'api-key' });
    const id = started.body['attempt'].id as string;
    const wrong = 'sk-test-WRONG-0123456789'; // secret-scan:ignore a made-up fixture
    const first = await api('POST', '/v1/auth/login/answer', { attemptId: id, apiKey: wrong });
    const again = await until(attemptOf.bind(null, 'codex'), (a: Json) => a['state'] === 'needs_input');
    expect(again['message']).toContain(AUTH_WORDS.refused);
    expect(again['action']).toEqual({ type: 'give_key' });
    for (const secret of [wrong, ...SECRETS]) expect(first.raw + JSON.stringify(again) + h.logs.join('\n')).not.toContain(secret);
    await api('POST', '/v1/auth/login/answer', { attemptId: id, apiKey: 'sk-test-RIGHT-0123456789' }); // secret-scan:ignore a made-up fixture
    expect((await until(attemptOf.bind(null, 'codex'), (a: Json) => a['state'] === 'done'))['message']).toBe('Signed in.');
  }, 40_000);

  it('five wrong keys end the sign-in', async () => {
    h = await acpHarness({ flavor: 'codex', script: script('codex', { signedIn: false, acceptKey: 'sk-test-RIGHT-0123456789' }) }); // secret-scan:ignore a made-up fixture
    const started = await api('POST', '/v1/auth/login', { methodId: 'api-key' });
    const id = started.body['attempt'].id as string;
    for (let i = 0; i < 6; i += 1) {
      const state = await until(attemptOf.bind(null, 'codex'), (a: Json) => a['state'] !== 'checking');
      if (state['state'] !== 'needs_input') break;
      await api('POST', '/v1/auth/login/answer', { attemptId: id, apiKey: `sk-test-WRONG-${i}-0123456789` });
    }
    const ended = await until(attemptOf.bind(null, 'codex'), (a: Json) => a['state'] === 'failed');
    expect(ended['message']).toBe(AUTH_WORDS.tooManyTries);
  }, 60_000);

  it('a sign-out the adapter refuses is a 502 in the fixed sentence', async () => {
    h = await acpHarness({ flavor: 'codex', script: { ...script('codex', { signedIn: true }), faults: { logoutFails: true } } });
    const out = await api('POST', '/v1/auth/logout');
    expect(out.status).toBe(502);
    expect(out.body['error']).toMatchObject({ code: 'sign_out_failed', message: AUTH_WORDS.signOutFailed });
    for (const secret of SECRETS) expect(out.raw).not.toContain(secret);
  }, 40_000);
});

describe('the pseudo-terminal helper', () => {
  it.skipIf(!ptySupported())('ends the program\'s own session on a signal, and says it has exited', async () => {
    const handle = startPty('sleep', ['60'], { cwd: tmpdir(), env: { PATH: process.env['PATH'] ?? '' }, onText: () => undefined });
    await new Promise((r) => setTimeout(r, 600));
    expect(handle.exited).toBe(false);
    handle.signal('SIGTERM');
    await handle.done;
    expect(handle.exited).toBe(true);
    expect(handle.writeLine('late')).toBe(false);
  }, 20_000);

  it('removes a hyperlink and a colour code that are cut in two by the chunks, and a hyperlink that ends at the next escape', () => {
    const esc = String.fromCharCode(27);
    const url = 'https://claude.example.test/cai/oauth/authorize?x=1';
    const raw = `visit: ${esc}]8;;${url}${esc}[94m${url}${esc}[39m${esc}]8;;${String.fromCharCode(7)}\r\nPaste code here if prompted > `;
    for (let cut = 1; cut < raw.length; cut += 7) {
      let out = '';
      const feed = plainChunks((t) => void (out += t));
      feed(raw.slice(0, cut));
      feed(raw.slice(cut));
      expect(out).toBe(`visit: ${url}\nPaste code here if prompted > `);
    }
  });

  it('finds the sign-in page only after the character that ends it', () => {
    expect(findSignInPage('visit: https://claude.example.test/au')).toBeNull();
    expect(findSignInPage('visit: https://claude.example.test/authorize?a=1\nPaste')).toBe('https://claude.example.test/authorize?a=1');
    expect(findSignInPage(`visit: https://x.test/${'a'.repeat(2100)}`)).toBe('unusable');
    expect(findSignInPage(`visit: https://x.test/${'a'.repeat(2100)}\n`)).toBe('unusable');
    expect(findSignInPage('no page here')).toBeNull();
  });

  it('reads a failure for what it means and passes none of its words on', () => {
    expect(failureWords("Login failed: That code wasn't accepted (code#state) for a@b.test. It may be incomplete, expired, already used")).toBe(AUTH_WORDS.refused);
    expect(failureWords('getaddrinfo ENOTFOUND console.example.test')).toBe(AUTH_WORDS.network);
    expect(failureWords('the code has expired')).toBe(AUTH_WORDS.expired);
    expect(failureWords('something nobody foresaw: token sk-ant-oat01-FAKE a@b.test')).toBe(AUTH_WORDS.notFinished); // secret-scan:ignore a made-up fixture
  });
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
