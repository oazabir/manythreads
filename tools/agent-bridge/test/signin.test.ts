import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { childEnv } from '../src/runs.ts';
import { CODEX_RENEW_AFTER_MS, DEFAULT_LIMIT_WAIT_MS, classifyFailure, limitResetsAt, readCodexFileFacts, SigninGate } from '../src/signin.ts';
import { auth, events, FAKE_CODEX, harness, start, type Harness } from './support.ts';

// P19-06: the Claude sign-in in the bridge: the failure table, the gate that lets one run renew the file, the check route, and "after a 401, no retry".

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function signinDir(expiresInMs: number, scopes = ['user:inference']): string {
  const dir = mkdtempSync(join(tmpdir(), 'signin-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-a', refreshToken: 'fake-r0', expiresAt: Date.now() + expiresInMs, scopes } }));
  return dir;
}
const run = async (hh: Harness, input: string): Promise<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await start(hh, { input });
  const { run_id } = (await res.json()) as { run_id: string };
  const frames = await events(hh, run_id);
  return frames[frames.length - 1]!.data;
};

describe('the failure table', () => {
  it('tells a refused sign-in and a plan limit from other failures', () => {
    expect(classifyFailure('API Error: 401 FAKE401')).toBe('needs_sign_in');
    expect(classifyFailure('Claude AI usage limit reached|1900000000 FAKELIMIT')).toBe('plan_limit');
    expect(classifyFailure('Credit balance is too low')).toBeNull();
    expect(classifyFailure('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')).toBe('needs_sign_in');
    // a 401 a tool met on some website is not about the account
    expect(classifyFailure('the page at example.com answered 401 so I stopped')).toBeNull();
    expect(limitResetsAt('usage limit reached|1900000000')).toBe(1900000000000);
    expect(limitResetsAt('nothing here')).toBeNull();
  });
});

describe('the sign-in check', () => {
  it('answers from the file: ok, no_scope, and rejected when there is none', async () => {
    h = await harness({}, 'claude-code', { claudeConfigDir: signinDir(3600_000) });
    const check = async () => ((await (await fetch(`${h!.bridge.url}/v1/signin/check`, { method: 'POST', headers: auth })).json()) as { result: string }).result;
    expect(await check()).toBe('ok');
    await h.close();
    h = await harness({}, 'claude-code', { claudeConfigDir: signinDir(3600_000, ['user:profile']) });
    expect(await check()).toBe('no_scope');
    await h.close();
    h = await harness({}, 'claude-code', { claudeConfigDir: join(tmpdir(), 'nowhere-at-all') });
    expect(await check()).toBe('rejected');
  });
  it('needs the key, and is absent on a bridge with no Claude sign-in', async () => {
    h = await harness({}, 'claude-code', { claudeConfigDir: signinDir(3600_000) });
    expect((await fetch(`${h.bridge.url}/v1/signin/check`, { method: 'POST' })).status).toBe(401);
    await h.close();
    h = await harness();
    expect((await fetch(`${h.bridge.url}/v1/signin/check`, { method: 'POST', headers: auth })).status).toBe(404);
  });
});

describe('after a refused sign-in', () => {
  it('reports it once, starts no process for the next run, and clears when the file is replaced', async () => {
    const dir = signinDir(3600_000);
    h = await harness({}, 'claude-code', { claudeConfigDir: dir });
    const first = await run(h, 'FAKE401 please');
    expect(first).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
    const callsBefore = h.calls().length;
    const second = await run(h, 'hello');
    expect(second).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
    expect(h.calls().length).toBe(callsBefore);
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-b', refreshToken: 'fake-r1', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] } }));
    expect(await run(h, 'hello')).toMatchObject({ event: 'run.completed' });
  });
  it('a plan limit carries its reset time and the next run is refused without a process', async () => {
    h = await harness({}, 'claude-code', { claudeConfigDir: signinDir(3600_000) });
    const first = await run(h, 'FAKELIMIT');
    expect(first).toMatchObject({ event: 'run.failed', reason: 'plan_limit', resets_at: 1900000000000 });
    const before = h.calls().length;
    expect(await run(h, 'hi')).toMatchObject({ reason: 'plan_limit' });
    expect(h.calls().length).toBe(before);
  });
});

describe('the gate', () => {
  const twoRuns = async (hh: Harness): Promise<Array<Record<string, any>>> => Promise.all([run(hh, 'one'), run(hh, 'two')]); // eslint-disable-line @typescript-eslint/no-explicit-any

  it('without the gate, two runs near expiry both renew with the same token and one is signed out', async () => {
    const dir = signinDir(5 * 60_000);
    h = await harness({}, 'claude-code', {});
    // the stand-in reads the folder from its environment: give it to the profile, but give the bridge no gate
    h.config.profiles['default']!.env = { CLAUDE_CONFIG_DIR: dir };
    const results = await twoRuns(h);
    expect(results.map((r) => r['event']).sort()).toEqual(['run.completed', 'run.failed']);
  });

  it('with the gate, they take turns and both pass; the file ends with a fresh token', async () => {
    const dir = signinDir(5 * 60_000);
    h = await harness({}, 'claude-code', { claudeConfigDir: dir });
    h.config.profiles['default']!.env = { CLAUDE_CONFIG_DIR: dir };
    const results = await twoRuns(h);
    expect(results.map((r) => r['event'])).toEqual(['run.completed', 'run.completed']);
    expect(JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken).not.toBe('fake-r0');
  });

  it('far from expiry, runs are not held', async () => {
    const gate = new SigninGate(signinDir(5 * 3600_000));
    let inside = 0;
    let peak = 0;
    await Promise.all([1, 2, 3].map(() => gate.run(async () => { inside++; peak = Math.max(peak, inside); await new Promise((r) => setTimeout(r, 20)); inside--; })));
    expect(peak).toBe(3);
  });
});

describe('a plan limit with no reset time', () => {
  it('stands for a short while and then lets a run through', () => {
    let t = 1_000_000;
    const gate = new SigninGate(join(tmpdir(), 'nowhere-at-all'), () => t);
    gate.noteFailure('plan_limit', 'usage limit reached');
    expect(gate.standing()?.kind).toBe('plan_limit');
    t += DEFAULT_LIMIT_WAIT_MS + 1;
    expect(gate.standing()).toBeNull();
  });
});

// ---- Codex (P19-13) ---------------------------------------------------------------------------------------------------------------------------------------------
// The stand-in `codex` of the claude-pod-fake image replaces the refresh token on every renewal and fails a reused one, as the real one is documented to. Every file here is made up
// (key names of the real auth.json, canary values); nothing reads the operator's own ~/.codex.

const here = dirname(fileURLToPath(import.meta.url));
const STAND_IN_CODEX = join(here, '..', '..', '..', 'deploy', 'images', 'claude-pod-fake', 'fake-codex.mjs');
const FAKE_CODEX_FAILS = join(here, 'fixtures', 'fake-codex-account.mjs');
const CANARY = 'CANARY-CODEX-91c4';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown): string => `${b64({ alg: 'none' })}.${b64(payload)}.sig-${CANARY}`;

function codexDir(over: { lastRefresh?: string; access?: string; apiKey?: unknown; mode?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      auth_mode: over.mode ?? 'chatgpt',
      OPENAI_API_KEY: over.apiKey ?? null,
      tokens: { id_token: `fake-id-${CANARY}`, access_token: over.access ?? `fake-access-${CANARY}`, refresh_token: 'fake-refresh-r0', account_id: 'acct-canary' },
      last_refresh: over.lastRefresh ?? new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return dir;
}
const days = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
const text = (dir: string): string => readFileSync(join(dir, 'auth.json'), 'utf8');

async function codexHarness(dir: string | null, codexBin: string = STAND_IN_CODEX, withGate = true): Promise<{ hh: Harness; logs: string[] }> {
  const logs: string[] = [];
  const hh = await harness({ bin: { claude: 'claude-not-used', codex: codexBin } }, 'codex', { ...(dir !== null && withGate ? { codexHome: dir } : {}), log: (l: string) => void logs.push(l) });
  hh.config.profiles['default']!.env = { ...(dir !== null ? { CODEX_HOME: dir } : {}), FAKE_MODE_FILE: join(hh.dir, 'no-mode-file') };
  return { hh, logs };
}

describe('the Codex failure table', () => {
  it('tells a refused sign-in, a reused refresh token and a usage limit from other failures', () => {
    const c = (t: string) => classifyFailure(t, 'codex');
    expect(c('unexpected status 401 Unauthorized: Missing bearer or basic authentication in header')).toBe('needs_sign_in');
    expect(c('Your access token could not be refreshed because your refresh token was already used (refresh_token_reused). Please log out and sign in again.')).toBe('needs_sign_in');
    expect(c('Your access token could not be refreshed because your refresh token was revoked.')).toBe('needs_sign_in');
    expect(c('error: invalid_grant')).toBe('needs_sign_in');
    // the bare code alone (no sentence around it) is a reused token too: it is the one word a log may carry on its own
    expect(c('refresh_token_reused')).toBe('needs_sign_in');
    expect(c('Please run `codex login` to sign in again')).toBe('needs_sign_in');
    expect(c("You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again in 2 days 3 hours 4 minutes.")).toBe('plan_limit');
    expect(c("You've hit your usage limit. Try again later (stand-in).")).toBe('plan_limit');
    expect(c('FAKE401')).toBe('needs_sign_in');
    expect(c('FAKELIMIT')).toBe('plan_limit');
    // not about the account
    expect(c('the page at example.com answered 401 so I stopped')).toBeNull();
    expect(c('the model is overloaded, retrying')).toBeNull();
    expect(c('no rollout found for thread id gone-thread')).toBeNull();
    // the Claude rows stay Claude's, and Codex's stay Codex's
    expect(classifyFailure('refresh_token_reused', 'claude-code')).toBeNull();
    expect(classifyFailure('oauth token expired', 'codex')).toBeNull();
    expect(classifyFailure('Credit balance is too low')).toBeNull();
  });

  it('reads the reset time from "try again in ..." and from an epoch, and from nothing', () => {
    const now = 1_800_000_000_000;
    expect(limitResetsAt('or try again in 2 days 3 hours 4 minutes.', now)).toBe(now + (2 * 86_400 + 3 * 3600 + 4 * 60) * 1000);
    expect(limitResetsAt('try again in 45 minutes', now)).toBe(now + 45 * 60_000);
    expect(limitResetsAt('try again in 1 hour and 5 minutes', now)).toBe(now + 65 * 60_000);
    expect(limitResetsAt('try again in a while', now)).toBeNull();
    expect(limitResetsAt('limit|1900000000', now)).toBe(1_900_000_000_000);
    expect(limitResetsAt('try again in 0 minutes', now)).toBeNull();
  });
});

describe('the Codex file facts and the sign-in check', () => {
  it('reads the shape of auth.json and nothing else; a file with an API key or another login kind is not valid', () => {
    expect(readCodexFileFacts(codexDir())).toMatchObject({ exists: true, valid: true, expiresAt: null });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(readCodexFileFacts(codexDir({ access: jwt({ exp }) })).expiresAt).toBe(exp * 1000);
    expect(readCodexFileFacts(codexDir({ apiKey: 'sk-made-up' })).valid).toBe(false);
    expect(readCodexFileFacts(codexDir({ mode: 'apikey' })).valid).toBe(false);
    expect(readCodexFileFacts(join(tmpdir(), 'nowhere-at-all'))).toMatchObject({ exists: false, valid: false });
    const junk = mkdtempSync(join(tmpdir(), 'codex-home-'));
    dirs.push(junk);
    writeFileSync(join(junk, 'auth.json'), 'not json');
    expect(readCodexFileFacts(junk).valid).toBe(false);
    expect(JSON.stringify(readCodexFileFacts(codexDir()))).not.toContain(CANARY);
  });

  it('answers ok, and rejected for a file with an API key or none', async () => {
    const check = async (hh: Harness) => ((await (await fetch(`${hh.bridge.url}/v1/signin/check`, { method: 'POST', headers: auth })).json()) as { result: string }).result;
    let { hh } = await codexHarness(codexDir());
    h = hh;
    expect(await check(h)).toBe('ok');
    expect(await (await fetch(`${h.bridge.url}/health`, { headers: auth })).json()).toMatchObject({ signin: 'ok' });
    await h.close();
    ({ hh } = await codexHarness(codexDir({ apiKey: 'sk-made-up' })));
    h = hh;
    expect(await check(h)).toBe('rejected');
    await h.close();
    ({ hh } = await codexHarness(join(tmpdir(), 'nowhere-at-all')));
    h = hh;
    expect(await check(h)).toBe('rejected');
    expect((await fetch(`${h.bridge.url}/v1/signin/check`, { method: 'POST' })).status).toBe(401);
  });

  it('is absent on a bridge with no Codex home', async () => {
    const { hh } = await codexHarness(null);
    h = hh;
    expect((await fetch(`${h.bridge.url}/v1/signin/check`, { method: 'POST', headers: auth })).status).toBe(404);
  });
});

describe('the Codex gate', () => {
  const twoRuns = (hh: Harness): Promise<Array<Record<string, any>>> => Promise.all([run(hh, 'one'), run(hh, 'two')]); // eslint-disable-line @typescript-eslint/no-explicit-any

  it('without the gate, two runs started when the renewal is due both renew with the same refresh token and one meets refresh_token_reused', async () => {
    const dir = codexDir({ lastRefresh: days(9) });
    const { hh } = await codexHarness(dir, STAND_IN_CODEX, false);
    h = hh;
    const ends = await twoRuns(h);
    expect(ends.map((e) => e['event']).sort()).toEqual(['run.completed', 'run.failed']);
    expect(String(ends.find((e) => e['event'] === 'run.failed')!['error'])).toContain('refresh_token_reused');
  });

  it('with the gate, they take turns and both pass; the file ends with a fresh refresh token, every other byte as it was', async () => {
    const dir = codexDir({ lastRefresh: days(9) });
    const before = text(dir);
    const { hh } = await codexHarness(dir);
    h = hh;
    const ends = await twoRuns(h);
    expect(ends.map((e) => e['event'])).toEqual(['run.completed', 'run.completed']);
    const after = JSON.parse(text(dir));
    expect(after.tokens.refresh_token).toMatch(/^fake-refresh-[0-9a-f]{12}$/);
    expect(after.tokens.account_id).toBe(JSON.parse(before).tokens.account_id);
    expect(readdirSync(dir).sort()).toEqual(['.fake-used-refresh', 'auth.json']);
    // after the renewal nothing is held any more
    expect(await twoRuns(h)).toEqual([expect.objectContaining({ event: 'run.completed' }), expect.objectContaining({ event: 'run.completed' })]);
  });

  it('holds runs inside the window before the access token runs out, and not far from it; a stale last_refresh counts too', async () => {
    const peak = async (dir: string): Promise<number> => {
      const gate = new SigninGate(dir, Date.now, 'codex');
      let inside = 0;
      let top = 0;
      await Promise.all([1, 2, 3].map(() => gate.run(async () => { inside++; top = Math.max(top, inside); await new Promise((r) => setTimeout(r, 20)); inside--; })));
      return top;
    };
    expect(await peak(codexDir({ access: jwt({ exp: Math.floor(Date.now() / 1000) + 300 }) }))).toBe(1);
    expect(await peak(codexDir({ access: jwt({ exp: Math.floor(Date.now() / 1000) + 5 * 3600 }) }))).toBe(3);
    expect(await peak(codexDir())).toBe(3);
    expect(await peak(codexDir({ lastRefresh: days(9) }))).toBe(1);
    expect(await peak(codexDir({ lastRefresh: new Date(Date.now() - CODEX_RENEW_AFTER_MS + 5 * 60_000).toISOString() }))).toBe(1);
    expect(await peak(codexDir({ lastRefresh: days(2) }))).toBe(3);
  });
});

describe('after a Codex account failure', () => {
  it('a refused sign-in is reported once, starts no process for the next run, and clears when the file is replaced', async () => {
    const dir = codexDir();
    const { hh } = await codexHarness(dir);
    h = hh;
    expect(await run(h, 'FAKE401 please')).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
    const stopped = await run(h, 'hello');
    expect(stopped).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in', error: 'The Codex sign-in was refused. An admin has to upload a new sign-in file.' });
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(dir, 'auth.json'), text(dir).replace('fake-refresh-r0', 'fake-refresh-r1'));
    expect(await run(h, 'hello')).toMatchObject({ event: 'run.completed' });
  });

  it('a plan limit stands, with its words for ChatGPT, and the next run starts no process', async () => {
    const { hh } = await codexHarness(codexDir(), FAKE_CODEX_FAILS);
    h = hh;
    const first = await run(h, "FAIL: You've hit your usage limit. Try again in 3 hours 5 minutes.");
    expect(first).toMatchObject({ event: 'run.failed', reason: 'plan_limit' });
    expect(first['resets_at']).toBeGreaterThan(Date.now() + 3 * 3600_000);
    expect(first['resets_at']).toBeLessThan(Date.now() + 3 * 3600_000 + 10 * 60_000);
    const before = h.calls().length;
    expect(await run(h, 'hi')).toMatchObject({ reason: 'plan_limit', error: "The ChatGPT plan's limit was reached." });
    expect(h.calls().length).toBe(before);
  });

  it('a reused refresh token is never retried, even for a run that resumes a saved thread', async () => {
    const { hh } = await codexHarness(codexDir(), FAKE_CODEX);
    h = hh;
    const sessioned = async (input: string): Promise<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const { run_id } = (await (await start(h!, { input, session_id: 's1' })).json()) as { run_id: string };
      const frames = await events(h!, run_id);
      return frames[frames.length - 1]!.data;
    };
    expect(await sessioned('first')).toMatchObject({ event: 'run.completed' });
    h.config.bin.codex = FAKE_CODEX_FAILS;
    const before = h.calls().length;
    const end = await sessioned('FAIL: Your access token could not be refreshed because your refresh token was already used (refresh_token_reused).');
    expect(end).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
    expect(h.calls().length - before).toBe(1);
    // the run after it is refused before any process starts
    expect(await sessioned('again')).toMatchObject({ event: 'run.failed', reason: 'needs_sign_in' });
    expect(h.calls().length - before).toBe(1);
  });

  it('a saved thread that Codex no longer has is still retried once, as a new thread (the one retry that stays)', async () => {
    const { hh } = await codexHarness(codexDir(), FAKE_CODEX);
    h = hh;
    const sessioned = async (input: string): Promise<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const { run_id } = (await (await start(h!, { input, session_id: 's2' })).json()) as { run_id: string };
      const frames = await events(h!, run_id);
      return frames[frames.length - 1]!.data;
    };
    expect(await sessioned('first')).toMatchObject({ event: 'run.completed' });
    h.config.bin.codex = FAKE_CODEX_FAILS;
    const before = h.calls().length;
    expect(await sessioned('FAIL: no rollout found for thread id thread-abc')).toMatchObject({ event: 'run.failed' });
    expect(h.calls().length - before).toBe(2);
  });
});

describe('the Codex child never gets an API key in a pod', () => {
  const profile = (extra: Record<string, unknown> = {}) => ({ agent: 'codex' as const, workdir: '/w', ...extra }) as Parameters<typeof childEnv>[0];
  const from = { PATH: '/bin', CODEX_HOME: '/state/codex', OPENAI_API_KEY: 'sk-made-up', GITHUB_TOKEN: 'ghp-no' };

  it('in a pod it is dropped from the allowlist, from passEnv and from the profile env', () => {
    const pod = { ...from, MANYTHREADS_BRIDGE_IN_POD: '1' };
    expect(childEnv(profile(), pod)).toEqual({ PATH: '/bin', CODEX_HOME: '/state/codex' });
    expect(childEnv(profile({ passEnv: ['OPENAI_API_KEY'] }), pod)['OPENAI_API_KEY']).toBeUndefined();
    expect(childEnv(profile({ env: { OPENAI_API_KEY: 'sk-from-profile' } }), pod)['OPENAI_API_KEY']).toBeUndefined();
    expect(childEnv(profile(), pod)['MANYTHREADS_BRIDGE_IN_POD']).toBeUndefined();
  });

  it('on a host (no flag) it is passed as before, and a Claude child is not touched', () => {
    expect(childEnv(profile(), from)['OPENAI_API_KEY']).toBe('sk-made-up');
    expect(childEnv({ agent: 'claude-code', workdir: '/w', env: { OPENAI_API_KEY: 'kept' } } as Parameters<typeof childEnv>[0], { MANYTHREADS_BRIDGE_IN_POD: '1' })['OPENAI_API_KEY']).toBe('kept');
  });

  it('end to end: the process the bridge starts has no OPENAI_API_KEY in its environment', async () => {
    process.env['MANYTHREADS_BRIDGE_IN_POD'] = '1';
    process.env['OPENAI_API_KEY'] = 'sk-made-up-canary';
    try {
      const { hh } = await codexHarness(null, FAKE_CODEX);
      h = hh;
      h.config.profiles['default']!.passEnv = ['FAKE_CLI_DIR', 'OPENAI_API_KEY'];
      expect(await run(h, 'hello')).toMatchObject({ event: 'run.completed' });
      const keys = h.calls().at(-1)!['envKeys'] as string[];
      expect(keys).not.toContain('OPENAI_API_KEY');
      expect(keys).not.toContain('MANYTHREADS_BRIDGE_IN_POD');
    } finally {
      delete process.env['MANYTHREADS_BRIDGE_IN_POD'];
      delete process.env['OPENAI_API_KEY'];
    }
  });
});

describe('a token canary in the sign-in file', () => {
  it('appears in no event, answer, check result, health answer or log line, through a renewal, a refusal and a limit', async () => {
    const dir = codexDir({ lastRefresh: days(9) });
    const { hh, logs } = await codexHarness(dir);
    h = hh;
    const seen: string[] = [];
    for (const input of ['plain', 'FAKEREFRESH', 'FAKELIMIT']) {
      const { run_id } = (await (await start(h, { input })).json()) as { run_id: string };
      seen.push(JSON.stringify(await events(h, run_id)), JSON.stringify(await (await fetch(`${h.bridge.url}/p/default/v1/runs/${run_id}`, { headers: auth })).json()));
    }
    seen.push(await (await fetch(`${h.bridge.url}/v1/signin/check`, { method: 'POST', headers: auth })).text(), await (await fetch(`${h.bridge.url}/health`, { headers: auth })).text());
    expect(seen.join('\n')).not.toContain(CANARY);
    expect(logs.join('\n')).not.toContain(CANARY);
    expect(logs.join('\n')).not.toContain('fake-refresh');
    // the file is still the canary's (the renewal replaced the refresh token, not the others)
    expect(text(dir)).toContain(CANARY);
  });
});
