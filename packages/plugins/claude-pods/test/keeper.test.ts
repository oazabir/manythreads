import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
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
