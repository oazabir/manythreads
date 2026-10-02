import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, guardedFetch, isPrivateAddress, privateIssuersBlocked } from '../src/net-guard.ts';
import { DiscoveryError, discoverIssuer, resetProtocolCaches } from '../src/protocol.ts';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '::10.0.0.1',
    '64:ff9b::7f00:1',
    'not an address',
  ])('%s is private', (a) => {
    expect(isPrivateAddress(a)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s is public', (a) => {
    expect(isPrivateAddress(a)).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it.each([
    'http://accounts.example.com/',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5:8443/',
    'https://metadata.google.internal/',
    'https://svc.local/',
    'https://user:pw@accounts.example.com/',
    'file:///etc/passwd',
    'nonsense',
  ])('refuses %s', (u) => {
    expect(() => assertPublicUrl(u)).toThrow();
  });
  it('accepts a public https url', () => {
    expect(assertPublicUrl('https://accounts.google.com/.well-known/openid-configuration').hostname).toBe('accounts.google.com');
  });
});

describe('guardedFetch', () => {
  it('never connects to a private literal or a name that resolves to one', async () => {
    await expect(guardedFetch('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/private network/);
    await expect(guardedFetch('https://localhost:1/')).rejects.toThrow(/private network/);
    await expect(guardedFetch('http://example.com/')).rejects.toThrow(/https/);
  });
});

describe('production issuer guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetProtocolCaches();
  });

  it('is on in production only, and can be relaxed for an in-cluster provider', () => {
    expect(privateIssuersBlocked({ NODE_ENV: 'production' })).toBe(true);
    expect(privateIssuersBlocked({ NODE_ENV: 'production', MANYTHREADS_OIDC_ALLOW_PRIVATE_ISSUERS: '1' })).toBe(false);
    expect(privateIssuersBlocked({ NODE_ENV: 'test' })).toBe(false);
    expect(privateIssuersBlocked({})).toBe(false);
  });

  it('refuses loopback and internal issuers before any request is made', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const issuer of ['http://localhost:8080/google', 'https://169.254.169.254/', 'https://10.0.0.7/realms/x', 'https://localhost/']) {
      await expect(discoverIssuer(issuer, 'client', { fresh: true })).rejects.toBeInstanceOf(DiscoveryError);
    }
  });
});
