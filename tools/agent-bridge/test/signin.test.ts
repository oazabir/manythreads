import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT_WAIT_MS, classifyFailure, limitResetsAt, SigninGate } from '../src/signin.ts';
import { auth, events, harness, start, type Harness } from './support.ts';

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
