import { mkdtempSync, rmSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JavaScript file that ships in the image
import { lookOnce, STABLE_MS } from '../../../../deploy/images/claude-pod/keeper.mjs';

// P19-06: the keeper copies a renewed sign-in file back, exactly, once it has held still.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const doc = (refresh: string): string => JSON.stringify({ claudeAiOauth: { accessToken: 'fake-a', refreshToken: refresh, expiresAt: 1, scopes: ['user:inference'] }, mcpOAuth: { 'x|1': {} } }, null, 2) + '\n';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-'));
  dirs.push(dir);
  const file = join(dir, '.credentials.json');
  const pushed: Buffer[] = [];
  let t = 1_000_000;
  const state: Record<string, unknown> = {};
  const look = () => lookOnce({ file, state, now: () => t, push: async (b: Buffer) => void pushed.push(b) }) as Promise<string>;
  return { file, pushed, state, look, advance: (ms: number) => (t += ms) };
}

describe('the keeper', () => {
  it('does nothing for the copy the pod started with, and copies a renewed file back byte for byte after it held still', async () => {
    const k = setup();
    writeFileSync(k.file, doc('r0'));
    expect(await k.look()).toBe('same');
    const renewed = doc('r1');
    writeFileSync(k.file, renewed);
    expect(await k.look()).toBe('waiting');
    k.advance(STABLE_MS - 1);
    expect(await k.look()).toBe('waiting');
    k.advance(2);
    expect(await k.look()).toBe('pushed');
    expect(k.pushed).toHaveLength(1);
    expect(k.pushed[0]!.toString('utf8')).toBe(renewed);
    expect(await k.look()).toBe('same');
    expect(k.pushed).toHaveLength(1);
  });

  it('waits again when the file changes while it was waiting, and refuses a half-written file', async () => {
    const k = setup();
    writeFileSync(k.file, doc('r0'));
    await k.look();
    writeFileSync(k.file, doc('r1'));
    await k.look();
    k.advance(1500);
    writeFileSync(k.file, doc('r2-longer-token'));
    utimesSync(k.file, new Date(), new Date(Date.now() + 5000));
    expect(await k.look()).toBe('waiting');
    k.advance(STABLE_MS + 1);
    writeFileSync(k.file, '{"claudeAiOauth":');
    utimesSync(k.file, new Date(), new Date(Date.now() + 9000));
    expect(await k.look()).toBe('waiting');
    k.advance(STABLE_MS + 1);
    expect(await k.look()).toBe('bad');
    expect(k.pushed).toHaveLength(0);
  });

  it('says missing when there is no file', async () => {
    expect(await setup().look()).toBe('missing');
  });
});

// P19-13: the same keeper on a Codex pod: `auth.json`, a ChatGPT login's refresh token, and no copy while the tool's lock file is there.
const codexDoc = (refresh: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'fake-i', access_token: 'fake-a', refresh_token: refresh, account_id: 'acct' }, last_refresh: '2026-11-09T00:00:00Z', ...over }, null, 2) + '\n';

function codexSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'keeper-codex-'));
  dirs.push(dir);
  const file = join(dir, 'auth.json');
  const lockFile = join(dir, 'auth.lock');
  const pushed: Buffer[] = [];
  let t = 1_000_000;
  const state: Record<string, unknown> = {};
  const look = () => lookOnce({ file, lockFile, kind: 'codex', state, now: () => t, push: async (b: Buffer) => void pushed.push(b) }) as Promise<string>;
  return { file, lockFile, pushed, look, advance: (ms: number) => (t += ms) };
}

describe('the keeper on a Codex pod', () => {
  it('copies the renewed auth.json only after it held still and the lock file is gone', async () => {
    const k = codexSetup();
    writeFileSync(k.file, codexDoc('r0'));
    expect(await k.look()).toBe('same');
    const renewed = codexDoc('r1');
    writeFileSync(k.file, renewed);
    writeFileSync(k.lockFile, '');
    // the lock is there: still, but never copied, however long it waits
    expect(await k.look()).toBe('locked');
    k.advance(10 * STABLE_MS);
    expect(await k.look()).toBe('locked');
    expect(k.pushed).toHaveLength(0);
    // the lock goes: the quiet time counts from now, not from before
    unlinkSync(k.lockFile);
    expect(await k.look()).toBe('waiting');
    k.advance(STABLE_MS - 1);
    expect(await k.look()).toBe('waiting');
    expect(k.pushed).toHaveLength(0);
    k.advance(2);
    expect(await k.look()).toBe('pushed');
    expect(k.pushed).toHaveLength(1);
    expect(k.pushed[0]!.toString('utf8')).toBe(renewed);
    expect(await k.look()).toBe('same');
  });

  it('does not copy when the lock comes back just before the copy', async () => {
    const k = codexSetup();
    writeFileSync(k.file, codexDoc('r0'));
    await k.look();
    writeFileSync(k.file, codexDoc('r1'));
    await k.look();
    k.advance(STABLE_MS + 1);
    writeFileSync(k.lockFile, '');
    expect(await k.look()).toBe('locked');
    expect(k.pushed).toHaveLength(0);
  });

  it('refuses a file that holds an API key or no refresh token', async () => {
    for (const bad of [codexDoc('r1', { OPENAI_API_KEY: 'sk-made-up-canary' }), codexDoc('', {}), JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } })]) {
      const k = codexSetup();
      writeFileSync(k.file, codexDoc('r0'));
      await k.look();
      writeFileSync(k.file, bad);
      await k.look();
      k.advance(STABLE_MS + 1);
      expect(await k.look()).toBe('bad');
      expect(k.pushed).toHaveLength(0);
    }
  });

  it('a Claude file is not accepted on a Codex pod and the other way round', async () => {
    const k = setup();
    writeFileSync(k.file, doc('r0'));
    await k.look();
    writeFileSync(k.file, codexDoc('r1'));
    await k.look();
    k.advance(STABLE_MS + 1);
    expect(await k.look()).toBe('bad');
  });
});
