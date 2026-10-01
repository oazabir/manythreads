import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * Outbound request guard for everything the OIDC flow fetches from an address an admin (or the provider's discovery
 * document) supplied: the discovery document, the token endpoint and the key set. Without it an admin could point a
 * provider at `http://169.254.169.254/` or an internal service and read the error text back (SSRF).
 *
 * Enforced when NODE_ENV is `production`, unless `MANYTHREADS_OIDC_ALLOW_PRIVATE_ISSUERS=1` (an identity provider that
 * lives inside the cluster or the LAN, e.g. a self-hosted Keycloak). Otherwise (development, tests) loopback and
 * private hosts are allowed so the mock issuer works.
 */
export function privateIssuersBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['MANYTHREADS_OIDC_ALLOW_PRIVATE_ISSUERS'] === '1') return false;
  return env['NODE_ENV'] === 'production';
}

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
}

/** True for loopback, private, link-local, multicast and other non-public addresses (IPv4 and IPv6, incl. mapped forms). */
export function isPrivateAddress(address: string): boolean {
  let ip = address.trim().replace(/^\[|\]$/g, '');
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const family = isIP(ip);
  if (family === 0) return true; // not an address at all: refuse
  if (family === 6) {
    // ::ffff:a.b.c.d and ::ffff:aabb:ccdd are IPv4 in disguise; also the deprecated IPv4-compatible ::a.b.c.d form.
    const mapped = /^(?:0{0,4}:){2,5}(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    const hex = /^(?:0{0,4}:){2,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if (hex?.[1] && hex[2]) {
      const hi = Number.parseInt(hex[1], 16);
      const lo = Number.parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

/** Refuses a URL that is not https, or whose host is a private address literal or `localhost`. Names are checked at connect time. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The address is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Only https addresses are allowed.');
  if (url.username || url.password) throw new Error('Addresses with credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('The address points at a private network.');
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) throw new Error('The address points at a private network.');
  return url;
}

/** DNS lookup that fails when ANY answer is a private address, and hands the connection a vetted address (no rebinding gap). */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses as unknown as string, family: 4 }];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error('The address points at a private network.') as NodeJS.ErrnoException, '', 4);
    }
    const first = list[0] as { address: string; family: number };
    if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    return callback(null, first.address, first.family);
  });
};

const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

/**
 * A `fetch` for the OIDC libraries (their `customFetch` hook) that only talks to public https hosts: no redirects are
 * followed (the libraries ask for `redirect: 'manual'`), the connection is made to an address that passed the check,
 * the answer is capped at 1 MiB and the whole call at ten seconds.
 */
export function guardedFetch(
  input: string | URL,
  init: { method?: string; headers?: ConstructorParameters<typeof Headers>[0]; body?: unknown; signal?: AbortSignal | null } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = assertPublicUrl(String(input));
    } catch (err) {
      reject(err);
      return;
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const payload = init.body === undefined || init.body === null ? undefined : String(init.body);
    if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
    const req = httpsRequest(
      url,
      { method: init.method ?? 'GET', headers, lookup: guardedLookup, timeout: TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error('The response is too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) for (const item of v) responseHeaders.append(k, item);
            else if (v !== undefined) responseHeaders.set(k, v);
          }
          const status = res.statusCode ?? 502;
          const noBody = status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400);
          resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('The server did not answer in time.')));
    req.on('error', reject);
    init.signal?.addEventListener('abort', () => req.destroy(new Error('The request was aborted.')), { once: true });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
