import { describe, expect, it } from 'vitest';
import { createOncePer, createWindowLimiter } from '../src/limiter.ts';
import { callIsSigned, githubSignature, hashWebhookSecret, newSigningSecret, newWebhookSecret, secretMatches, signatureMatches, tokenMatches } from '../src/secrets.ts';

describe('webhook secrets', () => {
  it('makes long, distinct, prefixed secrets', () => {
    const a = newWebhookSecret();
    const b = newWebhookSecret();
    expect(a).toMatch(/^mtwh_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(newSigningSecret()).toMatch(/^mtws_[A-Za-z0-9_-]{43}$/);
  });

  it('stores a 32-byte hash and compares against it', () => {
    const s = newWebhookSecret();
    const h = hashWebhookSecret(s);
    expect(h).toHaveLength(32);
    expect(h.toString('utf8')).not.toContain(s);
    expect(secretMatches(s, h)).toBe(true);
    expect(secretMatches(`${s}x`, h)).toBe(false);
    expect(secretMatches(newWebhookSecret(), h)).toBe(false);
    expect(secretMatches('', h)).toBe(false);
  });

  it('answers false, never throws, when there is no stored hash', () => {
    expect(secretMatches(newWebhookSecret(), null)).toBe(false);
  });
});

describe('call signatures', () => {
  const secret = 'mtws_test-signing-secret';
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');

  it('accepts GitHub X-Hub-Signature-256 over the raw bytes', () => {
    const sig = githubSignature(secret, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signatureMatches(secret, body, sig)).toBe(true);
  });

  it('rejects a changed body, a wrong secret and malformed headers', () => {
    const sig = githubSignature(secret, body);
    expect(signatureMatches(secret, Buffer.from('{"zen":"x"}'), sig)).toBe(false);
    expect(signatureMatches('other', body, sig)).toBe(false);
    expect(signatureMatches(secret, body, undefined)).toBe(false);
    expect(signatureMatches(secret, body, '')).toBe(false);
    expect(signatureMatches(secret, body, 'sha256=zz')).toBe(false);
    expect(signatureMatches(secret, body, sig.replace('sha256=', 'sha1='))).toBe(false);
    expect(signatureMatches(secret, body, `${sig}00`)).toBe(false);
  });

  it('accepts a GitLab token header and nothing else', () => {
    expect(tokenMatches(secret, secret)).toBe(true);
    expect(tokenMatches(secret, `${secret}x`)).toBe(false);
    expect(tokenMatches(secret, undefined)).toBe(false);
  });

  it('callIsSigned wants one valid proof', () => {
    expect(callIsSigned(secret, body, {})).toBe(false);
    expect(callIsSigned(secret, body, { 'x-hub-signature-256': githubSignature(secret, body) })).toBe(true);
    expect(callIsSigned(secret, body, { 'x-hub-signature-256': 'sha256=00' })).toBe(false);
    expect(callIsSigned(secret, body, { 'x-gitlab-token': secret })).toBe(true);
    expect(callIsSigned(secret, body, { 'x-gitlab-token': 'nope' })).toBe(false);
  });
});

describe('window limiter', () => {
  it('allows the limit, refuses the next, and recovers after the window', () => {
    let t = 1_000;
    const l = createWindowLimiter(() => t);
    for (let i = 0; i < 3; i++) expect(l.hit('a', 3, 60_000).allowed).toBe(true);
    const refused = l.hit('a', 3, 60_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(60_000);
    expect(l.hit('b', 3, 60_000).allowed).toBe(true);
    t += 30_000;
    expect(l.hit('a', 3, 60_000).allowed).toBe(false);
    t += 30_001;
    expect(l.hit('a', 3, 60_000).allowed).toBe(true);
  });

  it('does not count refused calls against the sender', () => {
    let t = 0;
    const l = createWindowLimiter(() => t);
    l.hit('k', 1, 1_000);
    for (let i = 0; i < 50; i++) {
      t += 10;
      expect(l.hit('k', 1, 1_000).allowed).toBe(false);
    }
    t = 1_001;
    expect(l.hit('k', 1, 1_000).allowed).toBe(true);
  });

  it('oncePer lets a key through once a window', () => {
    let t = 0;
    const once = createOncePer(60_000, () => t);
    expect(once('x')).toBe(true);
    expect(once('x')).toBe(false);
    expect(once('y')).toBe(true);
    t = 60_000;
    expect(once('x')).toBe(true);
  });
});
