import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';
import { isPublicAddress } from './address.ts';
import { systemResolver } from './resolver.ts';

// The one door the link-preview plugin reads an outside page through. A link in a message is typed by anybody, so what it points at is hostile until
// proven otherwise; the server must never be talked into reading an address on its own network (SSRF: server-side request forgery).
//
//   1. the address is parsed once: http or https only, port 80 or 443 only, a user name and password in it are dropped and never sent, `#fragment` dropped;
//   2. the name is resolved ONCE and every answer must be a public address (one private answer refuses the whole name: a mixed answer is how a rebinding
//      trick starts);
//   3. the socket is opened to that vetted address itself (a literal IP, not the name), with the name in the Host header and in TLS server-name checks,
//      so a second lookup can never lead somewhere else (DNS rebinding);
//   4. a redirect is a new request: it goes through steps 1 to 3 again, and through the caller's `check` (allow/deny lists, the egress guard); at most
//      `maxRedirects` are followed;
//   5. bytes are counted while they stream and the read stops at `maxBytes` (a compressed answer is counted after it is expanded: no zip bombs);
//   6. one clock covers the lookup, the connection, every redirect and the body: `timeoutMs` for the whole call (and never past `deadlineAt`, the
//      end of the whole job when one link takes several reads);
//   7. the lookup is not `dns.lookup` (libuv's four shared threads, which a dead name server can hold for many seconds): see resolver.ts.

export type SafeFetchErrorCode =
  | 'bad_url'
  | 'blocked_scheme'
  | 'blocked_port'
  | 'blocked_host'
  | 'blocked_address'
  | 'blocked_by_policy'
  | 'host_cooling'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'bad_redirect'
  | 'timeout'
  | 'too_large'
  | 'bad_status'
  | 'bad_type'
  | 'bad_encoding'
  | 'network';

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  /** True when the failure happened before any answer arrived (a refused connection): the next address may be tried. */
  readonly beforeResponse: boolean;
  constructor(code: SafeFetchErrorCode, message: string, beforeResponse = false) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
    this.beforeResponse = beforeResponse;
  }
}

/** Turns a name into addresses. The signal fires when the caller gives up; a resolver that can stop waiting then should. */
export type Resolver = (hostname: string, signal?: AbortSignal) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export interface SafeFetchDeps {
  /** Turns a name into addresses. Default: the bounded DNS resolver (two lookups at a time, one short try, a short memory of failed names). */
  resolve: Resolver;
  /** Tests only: where the vetted public address is really reached (a local fake server). The vetting has already happened on `address`. */
  dial?: (address: string, port: number) => { host: string; port: number };
}

export { systemResolver };

export const DEFAULT_DEPS: SafeFetchDeps = { resolve: systemResolver };

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** `truncate` keeps the first `maxBytes` (a page: the tags we want are near the top); `fail` refuses a longer answer (a picture is whole or nothing). */
  overflow: 'truncate' | 'fail';
  accept: string;
  /** The final answer's content type must match, else `bad_type`. */
  contentType?: RegExp;
  userAgent?: string;
  /** The end of the whole job, as a clock time in ms (`Date.now()` scale): the call never runs past it, whatever `timeoutMs` says. */
  deadlineAt?: number;
  /** Runs for the first address and for every redirect target, before anything is sent. Throw to refuse. */
  check?: (url: URL) => void | Promise<void>;
}

export interface SafeFetchResult {
  /** The address the bytes came from, after redirects. */
  url: URL;
  status: number;
  contentType: string | null;
  body: Buffer;
  /** The answer was longer than `maxBytes` and was cut. */
  truncated: boolean;
  redirects: number;
}

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; ManythreadsLinkPreview/1.0)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_ADDRESSES = 4;
const BLOCKED_NAMES = ['localhost', '.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, '');

/**
 * Judges and cleans an address before any request: http(s) only, port 80 or 443 only, no user name or password (dropped, never sent), no `#fragment`,
 * a host that is not a local name, and an address literal that is public. Returns the cleaned URL; throws `SafeFetchError`.
 */
export function vetUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeFetchError('bad_url', 'That is not a web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('blocked_scheme', 'Only http and https addresses are read.');
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  // `new URL` drops the scheme's own default port, so a port here is another one, or the other scheme's default (http://host:443)
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw new SafeFetchError('blocked_port', 'Only ports 80 and 443 are read.');
  if (url.port !== '' && url.port !== defaultPort) throw new SafeFetchError('blocked_port', 'Only the usual port of http or https is read.');
  const host = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, '');
  if (host === '') throw new SafeFetchError('bad_url', 'The address has no host.');
  if (BLOCKED_NAMES.some((n) => (n.startsWith('.') ? host.endsWith(n) : host === n))) {
    throw new SafeFetchError('blocked_host', 'That host name is a local one.');
  }
  if (isIP(host) !== 0 && !isPublicAddress(host)) throw new SafeFetchError('blocked_address', 'That address is not a public one.');
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new SafeFetchError('timeout', 'The site did not answer in time.'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });

/** True when the bytes start like a zlib stream (RFC 1950): method 8 and a header whose two bytes divide by 31. Otherwise "deflate" is a raw stream. */
export function looksLikeZlib(head: Uint8Array): boolean {
  if (head.length < 2) return false;
  const b0 = head[0] as number;
  const b1 = head[1] as number;
  return (b0 & 0x0f) === 8 && ((b0 << 8) | b1) % 31 === 0;
}

/** The vetted addresses of the URL's host: a literal as it is, a name resolved once. Every answer must be public. */
async function vettedAddresses(url: URL, deps: SafeFetchDeps, signal: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  const host = stripBrackets(url.hostname).replace(/\.$/, '');
  const literal = isIP(host);
  if (literal !== 0) return [{ address: host, family: literal }];
  let answers: ReadonlyArray<{ address: string; family: number }>;
  try {
    answers = await deps.resolve(host, signal);
  } catch {
    throw new SafeFetchError('dns_failed', 'The host name could not be resolved.');
  }
  if (answers.length === 0) throw new SafeFetchError('dns_failed', 'The host name has no address.');
  for (const a of answers) {
    if (!isPublicAddress(a.address)) throw new SafeFetchError('blocked_address', 'That host name leads to an address that is not a public one.');
  }
  return answers.slice(0, MAX_ADDRESSES).map((a) => ({ address: a.address, family: isIP(a.address) }));
}

interface RawAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(url: URL, address: string, deps: SafeFetchDeps, opts: SafeFetchOptions, signal: AbortSignal): Promise<RawAnswer> {
  return new Promise<RawAnswer>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const hostname = stripBrackets(url.hostname);
    const port = url.port !== '' ? Number(url.port) : secure ? 443 : 80;
    const target = deps.dial ? deps.dial(address, port) : { host: address, port };
    let settled = false;
    let responded = false;
    let res: http.IncomingMessage | undefined;
    let decoder: Transform | undefined;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      decoder?.destroy();
      res?.destroy();
      req.destroy();
    };
    const finish = (err: SafeFetchError | null, value?: RawAnswer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value as RawAnswer);
    };
    function onAbort(): void {
      finish(new SafeFetchError('timeout', 'The site did not answer in time.'));
    }
    const transport = (secure ? https : http) as typeof https;
    const req = transport.request(
      {
        host: target.host,
        port: target.port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        agent: false,
        // the certificate is checked against the NAME, though the socket goes to the vetted address
        ...(secure && isIP(hostname) === 0 ? { servername: hostname } : {}),
        headers: {
          host: url.host,
          'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
          accept: opts.accept,
          'accept-encoding': 'gzip, deflate, br',
          connection: 'close',
        },
      },
      (incoming) => {
        res = incoming;
        responded = true;
        const status = incoming.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
          finish(null, { status, headers: incoming.headers, body: Buffer.alloc(0), truncated: false });
          return;
        }
        if (status < 200 || status >= 300) {
          finish(new SafeFetchError('bad_status', `The site answered ${status}.`));
          return;
        }
        const type = String(incoming.headers['content-type'] ?? '');
        if (opts.contentType && !opts.contentType.test(type)) {
          finish(new SafeFetchError('bad_type', 'The answer is not the kind of content we read.'));
          return;
        }
        const encoding = String(incoming.headers['content-encoding'] ?? '').trim().toLowerCase();
        const declared = Number(incoming.headers['content-length']);
        if (opts.overflow === 'fail' && encoding === '' && Number.isFinite(declared) && declared > opts.maxBytes) {
          finish(new SafeFetchError('too_large', 'The answer is larger than we read.'));
          return;
        }
        incoming.on('error', () => finish(new SafeFetchError('network', 'The connection failed while reading.')));
        incoming.on('close', () => {
          if (!incoming.complete) finish(new SafeFetchError('network', 'The connection closed early.'));
        });
        const chunks: Buffer[] = [];
        let size = 0;
        const readBody = (stream: Readable): void => {
          stream.on('data', (chunk: Buffer) => {
            if (settled) return;
            const room = opts.maxBytes - size;
            if (chunk.length > room) {
              if (opts.overflow === 'fail') {
                finish(new SafeFetchError('too_large', 'The answer is larger than we read.'));
                return;
              }
              if (room > 0) chunks.push(chunk.subarray(0, room));
              finish(null, { status, headers: incoming.headers, body: Buffer.concat(chunks), truncated: true });
              return;
            }
            chunks.push(chunk);
            size += chunk.length;
          });
          stream.on('end', () => finish(null, { status, headers: incoming.headers, body: Buffer.concat(chunks), truncated: false }));
          stream.on('error', () => finish(new SafeFetchError('network', 'The connection failed while reading.')));
        };
        const decodeWith = (made: Transform): void => {
          decoder = made;
          made.on('error', () => finish(new SafeFetchError('bad_encoding', 'The answer could not be decoded.')));
          incoming.pipe(made);
          readBody(made);
        };
        if (encoding === 'gzip' || encoding === 'x-gzip') decodeWith(zlib.createGunzip());
        else if (encoding === 'br') decodeWith(zlib.createBrotliDecompress());
        else if (encoding === 'deflate') {
          // "deflate" should be the zlib format, but many servers send the raw one; the first two bytes tell which (a zlib header is a checksum-valid pair)
          // (the first piece may be a single byte, so collect two before deciding)
          let head: Buffer = Buffer.alloc(0);
          const onData = (piece: Buffer): void => {
            head = Buffer.concat([head, piece]);
            if (head.length < 2) return;
            incoming.off('data', onData);
            incoming.off('end', onEnd);
            incoming.pause();
            incoming.unshift(head);
            decodeWith(looksLikeZlib(head) ? zlib.createInflate() : zlib.createInflateRaw());
          };
          const onEnd = (): void => {
            incoming.off('data', onData);
            if (head.length === 0) finish(null, { status, headers: incoming.headers, body: Buffer.alloc(0), truncated: false });
            else finish(new SafeFetchError('bad_encoding', 'The answer could not be decoded.'));
          };
          incoming.on('data', onData);
          incoming.once('end', onEnd);
        } else if (encoding === '' || encoding === 'identity') readBody(incoming);
        else finish(new SafeFetchError('bad_encoding', 'The answer uses a content encoding we do not read.'));
      },
    );
    req.on('error', () => finish(new SafeFetchError('network', 'The site could not be reached.', !responded)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else req.end();
  });
}

const headerText = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

/**
 * Reads one address under the rules at the top of this file and answers the bytes of the final page. Never follows a redirect to anything that
 * fails the same rules; never keeps a connection open past `timeoutMs`; throws `SafeFetchError` with a `code` the caller can log.
 */
export async function safeFetch(input: string | URL, opts: SafeFetchOptions, deps: SafeFetchDeps = DEFAULT_DEPS): Promise<SafeFetchResult> {
  const room = opts.deadlineAt === undefined ? opts.timeoutMs : Math.min(opts.timeoutMs, opts.deadlineAt - Date.now());
  if (room <= 0) throw new SafeFetchError('timeout', 'The whole read took too long.');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), room);
  try {
    let url = vetUrl(input);
    for (let hop = 0; ; hop += 1) {
      if (opts.check) await raceAbort(Promise.resolve(opts.check(url)), abort.signal);
      const addresses = await raceAbort(vettedAddresses(url, deps, abort.signal), abort.signal);
      let answer: RawAnswer | null = null;
      let failure: SafeFetchError | null = null;
      for (const address of addresses) {
        try {
          answer = await requestOnce(url, address.address, deps, opts, abort.signal);
          break;
        } catch (err) {
          if (!(err instanceof SafeFetchError)) throw err;
          failure = err;
          if (!err.beforeResponse) throw err;
        }
      }
      if (!answer) throw failure ?? new SafeFetchError('network', 'The site could not be reached.');
      if (REDIRECT_STATUSES.has(answer.status)) {
        if (hop >= opts.maxRedirects) throw new SafeFetchError('too_many_redirects', 'The link redirects too many times.');
        const location = headerText(answer.headers['location']);
        if (!location || location.length > 4000) throw new SafeFetchError('bad_redirect', 'The redirect has no usable target.');
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SafeFetchError('bad_redirect', 'The redirect has no usable target.');
        }
        url = vetUrl(next);
        continue;
      }
      return { url, status: answer.status, contentType: headerText(answer.headers['content-type']), body: answer.body, truncated: answer.truncated, redirects: hop };
    }
  } finally {
    clearTimeout(timer);
  }
}
