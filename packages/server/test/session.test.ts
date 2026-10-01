import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_CONFIG, sessionConfigFromEnv } from '../src/session/config.ts';
import { deviceLabel } from '../src/session/device.ts';
import { csrfTokenFor, hashToken, newSessionToken, safeEqual } from '../src/session/tokens.ts';
import { tokensMatch } from '../src/session/test-auth.ts';

describe('session config', () => {
  it('defaults: 30 minutes idle, 30 days absolute, rotate every 4 hours, Secure on', () => {
    const c = sessionConfigFromEnv({});
    expect(c).toMatchObject({ idleMs: 30 * 60_000, absoluteMs: 30 * 86_400_000, rotateMs: 4 * 3_600_000, secureCookies: true });
    expect(DEFAULT_SESSION_CONFIG.idleMs).toBe(c.idleMs);
  });

  it('reads the lifetimes from the environment and ignores junk', () => {
    const c = sessionConfigFromEnv({
      MANYTHREADS_SESSION_IDLE_MINUTES: '5',
      MANYTHREADS_SESSION_ABSOLUTE_DAYS: '7',
      MANYTHREADS_SESSION_ROTATE_HOURS: 'soon',
    });
    expect(c.idleMs).toBe(5 * 60_000);
    expect(c.absoluteMs).toBe(7 * 86_400_000);
    expect(c.rotateMs).toBe(4 * 3_600_000);
  });

  it('Secure unless NODE_ENV is test or development, or the public URL is plain http; the override wins', () => {
    expect(sessionConfigFromEnv({ NODE_ENV: 'production' }).secureCookies).toBe(true);
    expect(sessionConfigFromEnv({ NODE_ENV: 'test' }).secureCookies).toBe(false);
    expect(sessionConfigFromEnv({ NODE_ENV: 'development' }).secureCookies).toBe(false);
    expect(sessionConfigFromEnv({ NODE_ENV: 'production', MANYTHREADS_PUBLIC_URL: 'http://wiki.lan' }).secureCookies).toBe(false);
    expect(sessionConfigFromEnv({ NODE_ENV: 'production', MANYTHREADS_PUBLIC_URL: 'https://x.example' }).secureCookies).toBe(true);
    expect(sessionConfigFromEnv({ NODE_ENV: 'test', MANYTHREADS_COOKIE_SECURE: '1' }).secureCookies).toBe(true);
    expect(sessionConfigFromEnv({ NODE_ENV: 'production', MANYTHREADS_COOKIE_SECURE: '0' }).secureCookies).toBe(false);
  });
});

describe('tokens', () => {
  it('session tokens are 256 random bits and differ every time', () => {
    const a = newSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(a);
  });

  it('stores sha256, and the CSRF token is bound to the session token', () => {
    const t = newSessionToken();
    expect(hashToken(t)).toHaveLength(32);
    expect(csrfTokenFor(t)).toBe(csrfTokenFor(t));
    expect(csrfTokenFor(t)).not.toBe(csrfTokenFor(newSessionToken()));
    expect(csrfTokenFor(t)).not.toContain(t);
  });

  it('compares in constant time and tolerates different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(tokensMatch('secret', 'secret')).toBe(true);
    expect(tokensMatch('secret', 'secrets')).toBe(false);
    expect(tokensMatch(undefined, 'secret')).toBe(false);
    expect(tokensMatch(['secret'], 'secret')).toBe(false);
  });
});

describe('device label', () => {
  it('names the browser and the system, never the raw header', () => {
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36')).toBe('Chrome on macOS');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64) Firefox/127.0')).toBe('Firefox on Linux');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/604.1')).toBe('Safari on iOS');
    expect(deviceLabel(undefined)).toBe('Unknown device');
    expect(deviceLabel('')).toBe('Unknown device');
  });
});
