import { randomBytes } from 'node:crypto';
import { APP_TOKEN_PREFIX, APP_TOKEN_TTL_SECONDS, isPathInsideFolder, repoAppTokenPath, splitRepoAppRest } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { appTokenSecretFromEnv, createAppTokens } from '../src/app-token.ts';

// Per-open tokens of embedded apps (PLAN P4-10): signature, expiry, scope (team and folder), tampering.

const ACTOR = '00000000-0000-7000-8000-000000000a01';
const WORKSPACE = '00000000-0000-7000-8000-0000000000a1';
const secret = randomBytes(32);

function setup(start = Date.parse('2026-03-02T09:00:00Z')) {
  let now = start;
  const tokens = createAppTokens({ secret, now: () => new Date(now) });
  const issue = (over: Partial<{ slug: string; folder: string }> = {}) =>
    tokens.issue({ actorId: ACTOR, workspaceId: WORKSPACE, slug: over.slug ?? 'engineering', folder: over.folder ?? 'apps/release-checklist' });
  return { tokens, issue, advance: (seconds: number) => void (now += seconds * 1000), start };
}

describe('app tokens', () => {
  it('a token opens its own app: the folder itself and everything below it', () => {
    const { tokens, issue } = setup();
    const { token } = issue();
    for (const path of ['apps/release-checklist', 'apps/release-checklist/index.html', 'apps/release-checklist/js/app.js', 'apps/release-checklist/__manythreads.js']) {
      const res = tokens.verify(token, { slug: 'engineering', path });
      expect(res.ok, path).toBe(true);
    }
    const ok = tokens.verify(token, { slug: 'engineering', path: 'apps/release-checklist/index.html' });
    expect(ok).toMatchObject({ ok: true, claim: { a: ACTOR, w: WORKSPACE, t: 'engineering', p: 'apps/release-checklist' } });
  });

  it('lives five minutes, to the second', () => {
    const { tokens, issue, advance, start } = setup();
    const { token, expiresAt } = issue();
    expect(APP_TOKEN_TTL_SECONDS).toBe(300);
    expect(expiresAt.getTime()).toBe(start + 300_000);
    const scope = { slug: 'engineering', path: 'apps/release-checklist/index.html' };
    advance(299);
    expect(tokens.verify(token, scope).ok).toBe(true);
    advance(1);
    expect(tokens.verify(token, scope)).toEqual({ ok: false, reason: 'expired' });
    advance(3600);
    expect(tokens.verify(token, scope)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses another folder: a sibling, a longer name, the parent, a traversal, the root', () => {
    const { tokens, issue } = setup();
    const { token } = issue();
    for (const path of [
      'apps/other/index.html',
      'apps/release-checklist-2/index.html', // same prefix, another folder
      'apps/release-checklist-evil',
      'apps',
      'apps/release-checklist/../other/index.html',
      'apps/release-checklist/./index.html',
      'apps/release-checklist//index.html',
      'apps/release-checklist/..',
      'bots/coder/BOT.md',
      'TEAM.md',
      '',
    ]) {
      expect(tokens.verify(token, { slug: 'engineering', path }), path).toEqual({ ok: false, reason: 'path' });
    }
  });

  it('refuses another team, even for the same folder name', () => {
    const { tokens, issue } = setup();
    const { token } = issue();
    for (const slug of ['marketing', 'customer-support', 'Engineering', 'engineering ', '']) {
      expect(tokens.verify(token, { slug, path: 'apps/release-checklist/index.html' }), JSON.stringify(slug)).toEqual({ ok: false, reason: 'team' });
    }
  });

  it('refuses a tampered token: a changed claim, a changed signature, a truncated or extended one', () => {
    const { tokens, issue } = setup();
    const scope = { slug: 'engineering', path: 'apps/release-checklist/index.html' };
    const { token } = issue();
    const [v, payload, sig] = token.split('.') as [string, string, string];
    // the claim rewritten to another folder and team, with the old signature
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), p: 'bots', t: 'marketing' })).toString('base64url');
    expect(tokens.verify(`${v}.${forged}.${sig}`, { slug: 'marketing', path: 'bots/coder/BOT.md' })).toEqual({ ok: false, reason: 'signature' });
    // the expiry pushed out
    const longer = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), e: 4_102_444_800 })).toString('base64url');
    expect(tokens.verify(`${v}.${longer}.${sig}`, scope)).toEqual({ ok: false, reason: 'signature' });
    // one character of the signature, one of the payload
    const flip = (s: string): string => `${s.slice(0, 5)}${s[5] === 'A' ? 'B' : 'A'}${s.slice(6)}`;
    expect(tokens.verify(`${v}.${payload}.${flip(sig)}`, scope).ok).toBe(false);
    expect(tokens.verify(`${v}.${flip(payload)}.${sig}`, scope).ok).toBe(false);
    // shape
    for (const bad of ['', 'v1', 'v1..', `v1.${payload}`, `v1.${payload}.`, `v2.${payload}.${sig}`, `${token}.x`, `${token}${sig}`, token.slice(0, -4), 'x'.repeat(5000), `v1.${payload}.${sig.slice(0, 10)}`]) {
      expect(tokens.verify(bad, scope).ok, bad.slice(0, 30)).toBe(false);
    }
  });

  it('refuses a token signed with another key, and a validly signed token with a claim of the wrong shape', () => {
    const a = setup();
    const other = createAppTokens({ secret: randomBytes(32), now: () => new Date(a.start) });
    const foreign = other.issue({ actorId: ACTOR, workspaceId: WORKSPACE, slug: 'engineering', folder: 'apps/release-checklist' });
    expect(a.tokens.verify(foreign.token, { slug: 'engineering', path: 'apps/release-checklist/index.html' })).toEqual({ ok: false, reason: 'signature' });
    // an actor id that is not a uuid is a malformed claim even with a good signature
    const bad = a.tokens.issue({ actorId: 'not-a-uuid', workspaceId: WORKSPACE, slug: 'engineering', folder: 'apps/x' });
    expect(a.tokens.verify(bad.token, { slug: 'engineering', path: 'apps/x/index.html' })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('is derived from the master key (same key, same secret; a different key, a different one), random without one', () => {
    const kms = randomBytes(32).toString('base64');
    expect(appTokenSecretFromEnv({ MANYTHREADS_KMS_KEY: kms }).equals(appTokenSecretFromEnv({ MANYTHREADS_KMS_KEY: kms }))).toBe(true);
    expect(appTokenSecretFromEnv({ MANYTHREADS_KMS_KEY: kms }).equals(Buffer.from(kms, 'base64'))).toBe(false); // not the wrapping key itself
    expect(appTokenSecretFromEnv({ MANYTHREADS_KMS_KEY: randomBytes(32).toString('base64') }).equals(appTokenSecretFromEnv({ MANYTHREADS_KMS_KEY: kms }))).toBe(false);
    expect(appTokenSecretFromEnv({}).equals(appTokenSecretFromEnv({}))).toBe(false);
    expect(() => createAppTokens({ secret: 'short' })).toThrow(/at least 16 bytes/);
  });
});

describe('the token in the route', () => {
  it('splits the token from the path, and keeps a path that merely looks similar', () => {
    expect(splitRepoAppRest(`${APP_TOKEN_PREFIX}abc.def/apps/x/index.html`)).toEqual({ token: 'abc.def', path: 'apps/x/index.html' });
    expect(splitRepoAppRest('apps/x/index.html')).toEqual({ token: null, path: 'apps/x/index.html' });
    expect(splitRepoAppRest(`${APP_TOKEN_PREFIX}abc`)).toEqual({ token: 'abc', path: '' });
    expect(splitRepoAppRest(`apps/${APP_TOKEN_PREFIX}abc/x`)).toEqual({ token: null, path: `apps/${APP_TOKEN_PREFIX}abc/x` });
  });

  it('builds a path whose relative URLs keep the token', () => {
    const url = repoAppTokenPath('engineering', 'v1.AAA_-.BBB', 'apps/release-checklist');
    expect(url).toBe('/api/teams/engineering/repo/app/~mta.v1.AAA_-.BBB/apps/release-checklist/index.html');
    expect(new URL('__manythreads.js', `http://x${url}`).pathname).toBe('/api/teams/engineering/repo/app/~mta.v1.AAA_-.BBB/apps/release-checklist/__manythreads.js');
  });

  it('knows what is inside a folder', () => {
    expect(isPathInsideFolder('apps/a/b', 'apps/a')).toBe(true);
    expect(isPathInsideFolder('apps/ab', 'apps/a')).toBe(false);
    expect(isPathInsideFolder('apps/a/../b', 'apps/a')).toBe(false);
    expect(isPathInsideFolder('apps/a', '')).toBe(false);
  });
});
