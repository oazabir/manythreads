import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

// The outbound guard for the addresses a team lead types (Hermes connections). A lead is not an operator: left alone, "http://169.254.169.254/…"
// or "http://manythreads-postgres:5432" would make this server fetch from places only it can reach. So every request to such an address passes
// here, at the moment of use (DNS answers change, so saving once is not enough), and the address that is connected to is the address that was
// checked (the check is the socket's own `lookup`, not a separate resolution that could differ).
//
//  * Default (`MANYTHREADS_HERMES_ALLOWED_HOSTS` unset): public hosts and private ranges (10/8, 172.16/12, 192.168/16, fc00::/7 — a customer's own
//    Hermes lives there) are allowed. Always denied: loopback, link-local (incl. the cloud metadata address 169.254.169.254), unspecified and
//    multicast addresses, the Kubernetes API service address, and this deployment's own in-cluster names (`manythreads-*`, `*.svc.cluster.local`,
//    `kubernetes.default*`, `localhost`).
//  * `MANYTHREADS_HERMES_ALLOWED_HOSTS` set (comma list of host names, `*.suffix`, IPs and CIDRs): ONLY those are allowed. A listed entry is the
//    operator's explicit choice and overrides the denials above — it is how an in-cluster gateway or a loopback dev gateway is permitted.
//
// The team's own managed pod is registered by the platform, not by a lead, and is not sent through this guard.

export class OutboundBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`outbound request refused: ${reason}`);
    this.name = 'OutboundBlockedError';
  }
}

const DENIED_V4 = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4'];
// ::/96 is the IPv4-compatible range (::7f00:1 is 127.0.0.1 to some stacks), 64:ff9b::/96 the NAT64 range that maps IPv4 into IPv6.
const DENIED_V6 = ['::/128', '::1/128', '::/96', '64:ff9b::/96', 'fe80::/10', 'ff00::/8'];
/** The API service address of the common cluster setups (k3s, kubeadm); the pod's own `KUBERNETES_SERVICE_HOST` is added at check time. */
const K8S_API_ADDRESSES = ['10.43.0.1', '10.96.0.1'];

const blockList = (v4: readonly string[], v6: readonly string[]): net.BlockList => {
  const list = new net.BlockList();
  for (const cidr of v4) list.addSubnet(cidr.split('/')[0]!, Number(cidr.split('/')[1]), 'ipv4');
  for (const cidr of v6) list.addSubnet(cidr.split('/')[0]!, Number(cidr.split('/')[1]), 'ipv6');
  return list;
};
const DENIED = blockList(DENIED_V4, DENIED_V6);
const K8S_API = blockList(K8S_API_ADDRESSES.map((a) => `${a}/32`), []);

const DENIED_NAME = [/^localhost$/, /\.localhost$/, /^kubernetes(\.|$)/, /^manythreads-/, /\.svc\.cluster\.local$/, /\.svc$/, /^metadata\.google\.internal$/];

interface Allowed {
  names: string[];
  list: net.BlockList;
  any: boolean;
}

/** The operator's allow list, read from the environment each time it is needed (it can change without a restart of the caller's state). */
export function allowedFrom(env: NodeJS.ProcessEnv): Allowed | null {
  const raw = (env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] ?? '').trim();
  if (raw === '') return null;
  const names: string[] = [];
  const list = new net.BlockList();
  let any = false;
  for (const entry of raw.split(',').map((e) => e.trim().toLowerCase()).filter((e) => e !== '')) {
    const [host, bits] = entry.split('/') as [string, string | undefined];
    const kind = net.isIP(host);
    if (kind !== 0) {
      any = true;
      if (bits !== undefined) list.addSubnet(host, Number(bits), kind === 4 ? 'ipv4' : 'ipv6');
      else list.addAddress(host, kind === 4 ? 'ipv4' : 'ipv6');
    } else names.push(entry);
  }
  return { names, list, any };
}

const nameMatches = (host: string, patterns: readonly string[]): boolean =>
  patterns.some((p) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p));

/**
 * An IPv4-mapped IPv6 address is the IPv4 address it wraps, in whatever spelling it arrives: dotted (`::ffff:10.43.0.1`) or hex, which is how the
 * URL parser rewrites it (`[::ffff:a2b:1]`). Every check below sees the dotted IPv4 form.
 */
const unwrap = (address: string): string => {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1]!;
  const hex = /^(?:0:0:0:0:0|::)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return address;
};

const inList = (list: net.BlockList, address: string): boolean => {
  const kind = net.isIP(address);
  return kind !== 0 && list.check(address, kind === 4 ? 'ipv4' : 'ipv6');
};

/** Why this host NAME may not be connected to, or null. (Names are also checked after resolution, address by address.) */
export function checkHostName(rawHost: string, env: NodeJS.ProcessEnv): string | null {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host) !== 0) return checkAddress(host, env, true);
  const allowed = allowedFrom(env);
  if (allowed && nameMatches(host, allowed.names)) return null;
  if (DENIED_NAME.some((re) => re.test(host))) return 'that name belongs to this deployment or its cluster';
  if (allowed) return allowed.any || allowed.names.length > 0 ? null : 'no host is allowed'; // resolved addresses decide below
  return null;
}

/** Why this ADDRESS may not be connected to, or null. `literal`: the caller typed the address itself (no name matched to it). */
export function checkAddress(rawAddress: string, env: NodeJS.ProcessEnv, literal = false): string | null {
  const address = unwrap(rawAddress.toLowerCase());
  const allowed = allowedFrom(env);
  if (allowed && inList(allowed.list, address)) return null;
  if (inList(DENIED, address)) return 'loopback, link-local and unspecified addresses are never allowed';
  const own = (env['KUBERNETES_SERVICE_HOST'] ?? '').trim();
  if (inList(K8S_API, address) || (own !== '' && unwrap(own.toLowerCase()) === address)) return 'the cluster API address is never allowed';
  if (allowed) return literal ? 'that address is not on the allowed list' : 'a name resolved to an address that is not on the allowed list';
  return null;
}

export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: Lookup = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))));

/** Resolve a URL's host and check the name and every address it resolves to. Throws `OutboundBlockedError`. Used at save time and by the connection itself. */
export async function assertAllowedUrl(url: URL, env: NodeJS.ProcessEnv = process.env, lookup: Lookup = systemLookup): Promise<void> {
  const nameReason = checkHostName(url.hostname, env);
  if (nameReason) throw new OutboundBlockedError(nameReason);
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return;
  const allowed = allowedFrom(env);
  const addresses = await lookup(url.hostname);
  if (addresses.length === 0) throw new OutboundBlockedError('the name did not resolve');
  // A name the operator listed is trusted as a name, but what it resolves to is still never loopback/link-local unless that address is listed too.
  for (const { address } of addresses) {
    const reason = checkAddress(address, env);
    if (reason && !(allowed && nameMatches(url.hostname.toLowerCase(), allowed.names) && !inList(DENIED, unwrap(address)) )) throw new OutboundBlockedError(reason);
  }
}

export interface GuardedFetchOptions {
  env?: NodeJS.ProcessEnv;
  lookup?: Lookup;
}

/**
 * `fetch` for an address a lead typed: checks the name, then connects through a socket whose own DNS lookup checks every address it is about to
 * use, so the address checked is the address connected. A redirect is an error. Only what the gateway client needs: a string body, an abort
 * signal, and a streamed response.
 */
export function createGuardedFetch(options: GuardedFetchOptions = {}): typeof fetch {
  const guarded = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const env = options.env ?? process.env;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundBlockedError('only http and https');
    const nameReason = checkHostName(url.hostname, env);
    if (nameReason) throw new OutboundBlockedError(nameReason);
    const lookup = options.lookup ?? systemLookup;
    const allowed = allowedFrom(env);
    const hostLower = url.hostname.toLowerCase();
    const trustedName = allowed !== null && nameMatches(hostLower, allowed.names);
    const checkedLookup = (hostname: string, opts: unknown, cb: (...args: unknown[]) => void): void => {
      const wantsAll = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all === true;
      lookup(hostname).then(
        (addresses) => {
          for (const { address } of addresses) {
            const reason = checkAddress(address, env);
            if (reason && !(trustedName && !inList(DENIED, unwrap(address.toLowerCase())))) {
              cb(new OutboundBlockedError(reason));
              return;
            }
          }
          if (addresses.length === 0) cb(new OutboundBlockedError('the name did not resolve'));
          else if (wantsAll) cb(null, addresses);
          else cb(null, addresses[0]!.address, addresses[0]!.family);
        },
        (err: unknown) => cb(err),
      );
    };
    const literal = net.isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0;
    return new Promise<Response>((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body = typeof init.body === 'string' ? init.body : undefined;
      const req = mod.request(
        url,
        { method: init.method ?? 'GET', headers: { ...headers, ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) }, ...(literal ? {} : { lookup: checkedLookup as never }) },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            reject(new OutboundBlockedError('a redirect was refused'));
            return;
          }
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : v);
          const noBody = [101, 204, 205, 304].includes(status);
          if (noBody) res.resume();
          resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: responseHeaders }));
        },
      );
      req.on('error', reject);
      const signal = init.signal;
      if (signal) {
        const abort = (): void => {
          req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
  return guarded as typeof fetch;
}

export const guardedFetch: typeof fetch = createGuardedFetch();
