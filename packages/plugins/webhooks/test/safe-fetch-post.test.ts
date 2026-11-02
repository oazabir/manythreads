import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SafeFetchError, postRedirectRefusal, safeFetch, type SafeFetchDeps, type SafeFetchOptions } from '@manythreads/sdk/safe-fetch';

// The guarded fetch as an outgoing webhook uses it: a POST. Same rules as the preview fetch (public addresses only, the name resolved once and the vetted
// address dialled, every redirect vetted again, bounded time and bytes), plus: the body is sent whole, a POST follows only a 307 or 308, and a 4xx/5xx
// answer is an error that carries its status.

interface Seen {
  method: string | undefined;
  url: string | undefined;
  body: string;
  type: string | undefined;
  signature: string | undefined;
}
let server: Server;
let port = 0;
let seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8'), type: req.headers['content-type'], signature: req.headers['x-manythreads-signature'] as string | undefined });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  seen = [];
  handler = (_req, res) => res.end('ok');
});

const NAMES: Record<string, string[]> = {
  'hook.test': ['93.184.216.34'],
  'other.test': ['8.8.4.4'],
  'private.test': ['10.0.0.5'],
  'loop.test': ['127.0.0.1'],
  'meta.test': ['169.254.169.254'],
  'mapped.test': ['::ffff:127.0.0.1'],
  'mixed.test': ['93.184.216.34', '192.168.1.10'],
};
function deps(log: { resolved?: string[]; dialed?: string[] } = {}): SafeFetchDeps {
  return {
    resolve: async (host) => {
      log.resolved?.push(host);
      const list = NAMES[host];
      if (!list) throw new Error('ENOTFOUND');
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    dial: (address) => {
      log.dialed?.push(address);
      return { host: '127.0.0.1', port };
    },
  };
}
const post = (body = '{"a":1}', o: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
  method: 'POST',
  body: Buffer.from(body),
  headers: { 'content-type': 'application/json', 'x-manythreads-signature': 'v0=abc' },
  maxBytes: 64 * 1024,
  timeoutMs: 2_000,
  maxRedirects: 2,
  overflow: 'truncate',
  accept: 'application/json',
  ...o,
});
const refused = async (promise: Promise<unknown>): Promise<SafeFetchError> => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SafeFetchError);
    return err as SafeFetchError;
  }
  throw new Error('expected a refusal');
};

describe('POST through the guarded fetch', () => {
  it('sends the body and the headers once to the vetted address and returns the answer', async () => {
    const log = { resolved: [] as string[], dialed: [] as string[] };
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"text":"hi"}');
    };
    const r = await safeFetch('http://hook.test/in?x=1', post(), deps(log));
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('{"text":"hi"}');
    expect(seen).toEqual([{ method: 'POST', url: '/in?x=1', body: '{"a":1}', type: 'application/json', signature: 'v0=abc' }]);
    expect(log.resolved).toEqual(['hook.test']);
    expect(log.dialed).toEqual(['93.184.216.34']);
  });

  it('refuses private, loopback, link-local, mapped and mixed answers before anything is sent', async () => {
    for (const host of ['private.test', 'loop.test', 'meta.test', 'mapped.test', 'mixed.test']) {
      const err = await refused(safeFetch(`http://${host}/in`, post(), deps()));
      expect(err.code, host).toBe('blocked_address');
    }
    for (const literal of ['http://127.0.0.1/in', 'http://10.1.2.3/in', 'http://169.254.169.254/in', 'http://[::1]/in', 'http://[fd00::1]/in', 'http://0.0.0.0/in', 'http://2130706433/in', 'http://0x7f.1/in']) {
      const err = await refused(safeFetch(literal, post(), deps()));
      expect(['blocked_address', 'blocked_host', 'bad_url'], literal).toContain(err.code);
    }
    expect((await refused(safeFetch('http://localhost/in', post(), deps()))).code).toBe('blocked_host');
    expect((await refused(safeFetch('http://hook.test:8080/in', post(), deps()))).code).toBe('blocked_port');
    expect((await refused(safeFetch('ftp://hook.test/in', post(), deps()))).code).toBe('blocked_scheme');
    expect(seen).toHaveLength(0);
  });

  it('DNS rebinding: the name is resolved once and the vetted address is the one dialled', async () => {
    const log = { resolved: [] as string[], dialed: [] as string[] };
    let answers = 0;
    const flip: SafeFetchDeps = {
      resolve: async () => (answers++ === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]),
      dial: (address) => {
        log.dialed.push(address);
        return { host: '127.0.0.1', port };
      },
    };
    await safeFetch('http://hook.test/in', post(), flip);
    expect(answers).toBe(1);
    expect(log.dialed).toEqual(['93.184.216.34']);
  });

  it('follows a 307 and a 308 with the same body at the same host, vetting the new address again', async () => {
    handler = (req, res) => {
      if (req.url === '/in') {
        res.writeHead(308, { location: 'http://hook.test/next' });
        res.end();
      } else res.end('done');
    };
    const log = { dialed: [] as string[] };
    const r = await safeFetch('http://hook.test/in', post('{"keep":true}'), deps(log));
    expect(r.body.toString()).toBe('done');
    expect(r.redirects).toBe(1);
    expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([['POST', '/in', '{"keep":true}'], ['POST', '/next', '{"keep":true}']]);
    expect(log.dialed).toEqual(['93.184.216.34', '93.184.216.34']);
  });

  it('refuses to repeat a POST at another host (its headers may hold a signature or token), public or private, and sends nothing there', async () => {
    for (const target of ['http://other.test/next', 'http://meta.test/latest', 'http://hook.test.evil.test/x']) {
      seen = [];
      handler = (_req, res) => {
        res.writeHead(307, { location: target });
        res.end();
      };
      const err = await refused(safeFetch('http://hook.test/in', post('{"keep":true}', { headers: { 'x-manythreads-signature': 'v0=abc' } }), deps()));
      expect(err.code, target).toBe('bad_redirect');
      expect(seen, target).toHaveLength(1);
    }
  });

  it('never repeats a POST over a weaker connection: https to http is refused, http to https and the same scheme are allowed', () => {
    const u = (x: string): URL => new URL(x);
    expect(postRedirectRefusal(u('https://hook.test/in'), u('http://hook.test/in'))?.code).toBe('bad_redirect');
    expect(postRedirectRefusal(u('https://hook.test/in'), u('https://hook.test/next'))).toBeNull();
    expect(postRedirectRefusal(u('http://hook.test/in'), u('https://hook.test/in'))).toBeNull();
    expect(postRedirectRefusal(u('http://hook.test/in'), u('http://HOOK.test/next?x=1'))).toBeNull();
    expect(postRedirectRefusal(u('https://hook.test/in'), u('https://other.test/in'))?.code).toBe('bad_redirect');
  });

  it('does not follow 301, 302 or 303 for a POST: the status comes back as an error', async () => {
    for (const status of [301, 302, 303]) {
      seen = [];
      handler = (_req, res) => {
        res.writeHead(status, { location: 'http://other.test/next' });
        res.end();
      };
      const err = await refused(safeFetch('http://hook.test/in', post(), deps()));
      expect(err.code, String(status)).toBe('bad_status');
      expect(err.status).toBe(status);
      expect(seen).toHaveLength(1);
    }
  });

  it('stops after the redirects it is allowed, and carries the status of an error answer', async () => {
    handler = (_req, res) => {
      res.writeHead(307, { location: 'http://hook.test/again' });
      res.end();
    };
    expect((await refused(safeFetch('http://hook.test/in', post(), deps()))).code).toBe('too_many_redirects');
    expect(seen.length).toBeLessThanOrEqual(3);
    for (const status of [400, 404, 429, 500, 503]) {
      handler = (_req, res) => {
        res.writeHead(status);
        res.end('no');
      };
      const err = await refused(safeFetch('http://hook.test/in', post(), deps()));
      expect([err.code, err.status]).toEqual(['bad_status', status]);
    }
  });

  it('gives up after the time it is given, and cuts a long answer at the byte limit', async () => {
    handler = () => undefined; // never answers
    const t0 = Date.now();
    expect((await refused(safeFetch('http://hook.test/in', post('{}', { timeoutMs: 300 }), deps()))).code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(3_000);
    handler = (_req, res) => res.end('x'.repeat(200_000));
    const r = await safeFetch('http://hook.test/in', post('{}', { maxBytes: 1_000 }), deps());
    expect(r.body.length).toBeLessThanOrEqual(1_000);
    expect(r.truncated).toBe(true);
  });

  it('runs the guard check for the first address and for every redirect, and lets it refuse', async () => {
    const checked: string[] = [];
    handler = (req, res) => {
      if (req.url === '/in') {
        res.writeHead(307, { location: 'http://hook.test/next' });
        res.end();
      } else res.end('ok');
    };
    await safeFetch('http://hook.test/in', post('{}', { check: (u) => void checked.push(u.pathname) }), deps());
    expect(checked).toEqual(['/in', '/next']);
    seen = [];
    const err = await refused(
      safeFetch('http://hook.test/in', post('{}', { check: () => { throw new SafeFetchError('blocked_by_policy', 'no'); } }), deps()),
    );
    expect(err.code).toBe('blocked_by_policy');
    expect(seen).toHaveLength(0);
  });

  it('never lets the caller set the host, the length or the connection', async () => {
    await safeFetch('http://hook.test/in', post('{"a":1}', { headers: { host: 'evil.example', 'content-length': '1', connection: 'upgrade', 'content-type': 'application/json' } }), deps());
    expect(seen[0]!.body).toBe('{"a":1}');
  });
});
