import { describe, expect, it } from 'vitest';
import { checkClientIp, checkProxyMatch, classifyFetchError, readHttpsConfig, runHttpsChecks, type HttpsConfig } from '../src/https-checks.ts';

const cfg = (over: Partial<HttpsConfig> = {}): HttpsConfig => ({
  mode: 'cloudflare', origin: 'strict', wildcard: true, acmeServer: null, publicUrl: 'https://mt.example.com', appsDomain: 'apps.example.com', appsRouting: 'host', ...over,
});
const failing = (code: string, name = 'TypeError') => async () => {
  throw Object.assign(new Error('fetch failed'), { name, cause: { code } });
};
const answering = (status: number) => async () => ({ status, body: null });
const healthyOnly = async (u: string) => ({ status: u.endsWith('/healthz') ? 200 : 404 });
const req = { ip: '203.0.113.9', headers: {} as Record<string, string | undefined> };
const hex = () => 'abcd1234';

describe('readHttpsConfig', () => {
  it('defaults to none and ignores junk', () => {
    expect(readHttpsConfig({}, 'http://x').mode).toBe('none');
    expect(readHttpsConfig({ MANYTHREADS_TLS_MODE: 'weird' }, 'http://x').mode).toBe('none');
    expect(readHttpsConfig({ MANYTHREADS_TLS_MODE: 'none', MANYTHREADS_TLS_WILDCARD: '1' }, 'http://x').wildcard).toBe(false);
  });
  it('reads cloudflare and letsencrypt settings', () => {
    const c = readHttpsConfig({ MANYTHREADS_TLS_MODE: 'cloudflare', MANYTHREADS_TLS_ORIGIN: 'flexible', MANYTHREADS_TLS_WILDCARD: '1', MANYTHREADS_HERMES_PODS_APPS_HOST: 'Apps.Example.com' }, 'https://a');
    expect(c).toMatchObject({ mode: 'cloudflare', origin: 'flexible', wildcard: true, appsDomain: 'apps.example.com', acmeServer: null });
    const l = readHttpsConfig({ MANYTHREADS_TLS_MODE: 'letsencrypt', MANYTHREADS_TLS_ACME_SERVER: 'staging', MANYTHREADS_HERMES_PODS_APPS_HOST: 'bad host/' }, 'https://a');
    expect(l).toMatchObject({ mode: 'letsencrypt', origin: null, acmeServer: 'staging', appsDomain: null });
  });
});

describe('path routing', () => {
  it('reads the routing, path by default', () => {
    expect(readHttpsConfig({}, 'http://x').appsRouting).toBe('path');
    expect(readHttpsConfig({ MANYTHREADS_HERMES_PODS_APPS_ROUTING: 'host' }, 'http://x').appsRouting).toBe('host');
    expect(readHttpsConfig({ MANYTHREADS_HERMES_PODS_APPS_ROUTING: 'nonsense' }, 'http://x').appsRouting).toBe('path');
  });
  it('skips the wildcard check without making any request', async () => {
    const seen: string[] = [];
    const spy = async (u: string) => {
      seen.push(u);
      return { status: 200, body: null };
    };
    const r = await runHttpsChecks(cfg({ appsRouting: 'path' }), req, spy, hex);
    expect(r.checks[1]).toMatchObject({ id: 'wildcard', status: 'skipped', detail: expect.stringContaining('no wildcard certificate is needed') });
    expect(seen.filter((u) => u.includes('mt-check-'))).toEqual([]);
    expect(r.appsRouting).toBe('path');
  });
});

describe('classifyFetchError', () => {
  it('sorts errors', () => {
    expect(classifyFetchError(Object.assign(new Error(), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyFetchError({ cause: { code: 'ENOTFOUND' } })).toBe('dns');
    expect(classifyFetchError({ cause: { code: 'CERT_HAS_EXPIRED' } })).toBe('tls');
    expect(classifyFetchError({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } })).toBe('tls');
    expect(classifyFetchError({ cause: { code: 'ECONNREFUSED' } })).toBe('refused');
    expect(classifyFetchError(new Error('x'))).toBe('other');
  });
});

describe('runHttpsChecks', () => {
  it('passes when everything answers', async () => {
    const r = await runHttpsChecks(cfg(), { ip: req.ip, headers: { 'cf-ray': 'r', 'cf-connecting-ip': req.ip } }, healthyOnly, hex);
    expect(r.domain).toBe('mt.example.com');
    expect(r.checks.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(r.seenAs).toEqual({ clientIp: req.ip, viaCloudflare: true });
  });
  it('probes only hosts built from configuration', async () => {
    const urls: string[] = [];
    await runHttpsChecks(cfg(), { ip: '1.1.1.1', headers: { host: 'evil.test', 'x-forwarded-host': 'evil.test' } }, async (u) => { urls.push(u); return { status: 200 }; }, hex);
    expect(urls.sort()).toEqual(['https://mt-check-abcd1234-probe.apps.example.com/', 'https://mt.example.com/healthz']);
  });
  it('reports a non-2xx health answer and a bad certificate with the Cloudflare hint', async () => {
    const r = await runHttpsChecks(cfg(), req, async (u) => (u.endsWith('/healthz') ? { status: 502 } : failing('ERR_TLS_CERT_ALTNAME_INVALID')()), hex);
    expect(r.checks[0]).toMatchObject({ id: 'public-url', status: 'fail' });
    expect(r.checks[0]?.detail).toContain('502');
    expect(r.checks[1]).toMatchObject({ id: 'wildcard', status: 'fail' });
    expect(r.checks[1]?.detail).toContain('one level below');
  });
  it('names the failure class for the public URL', async () => {
    const dns = await runHttpsChecks(cfg({ wildcard: false }), req, failing('ENOTFOUND'), hex);
    expect(dns.checks[0]?.detail).toContain('does not resolve');
    const slow = await runHttpsChecks(cfg({ wildcard: false }), req, failing('', 'TimeoutError'), hex);
    expect(slow.checks[0]?.detail).toContain('5 seconds');
  });
  it('skips what does not apply', async () => {
    const r = await runHttpsChecks(cfg({ mode: 'none', wildcard: false, publicUrl: 'http://localhost:3000', origin: null }), req, failing('X'), hex);
    expect(r.checks.map((c) => c.status)).toEqual(['skipped', 'skipped', 'ok', 'ok']);
    expect((await runHttpsChecks(cfg({ appsDomain: null }), req, answering(200), hex)).checks[1]?.status).toBe('skipped');
  });
});

describe('client address and proxy match', () => {
  it('warns when the derived address is not the Cloudflare one, ignoring the ::ffff: prefix', () => {
    expect(checkClientIp('10.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }).check.status).toBe('warn');
    expect(checkClientIp('::ffff:203.0.113.9', { 'cf-connecting-ip': '203.0.113.9' }).check.status).toBe('ok');
    expect(checkClientIp('10.0.0.1', {}).check.status).toBe('ok');
  });
  it('warns when the mode and the request path disagree', () => {
    expect(checkProxyMatch('cloudflare', {}).status).toBe('warn');
    expect(checkProxyMatch('letsencrypt', { 'cf-ray': 'x' }).status).toBe('warn');
    expect(checkProxyMatch('cloudflare', { 'cf-ray': 'x' }).status).toBe('ok');
    expect(checkProxyMatch('none', {}).status).toBe('ok');
  });
});
