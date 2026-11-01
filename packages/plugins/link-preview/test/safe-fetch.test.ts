import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFetchError, looksLikeZlib, safeFetch, vetUrl, type Resolver, type SafeFetchDeps, type SafeFetchOptions } from '../src/safe-fetch.ts';

// SSRF (server-side request forgery) table tests. No network and no real DNS: a fake resolver answers names, and `dial` sends the vetted public
// address to a local fake server, so the whole path (vet, resolve once, connect to the vetted address, re-vet each redirect, bound bytes and time) runs.

interface Seen {
  host: string | undefined;
  authorization: string | undefined;
  url: string | undefined;
  userAgent: string | undefined;
}

let server: Server;
let port = 0;
const seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = () => undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ host: req.headers.host, authorization: req.headers.authorization, url: req.url, userAgent: req.headers['user-agent'] });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const PUBLIC = '93.184.216.34';
const NAMES: Record<string, string[]> = {
  'example.test': [PUBLIC],
  'other.test': ['8.8.4.4'],
  'private.test': ['10.0.0.5'],
  'loop.test': ['127.0.0.1'],
  'meta.test': ['169.254.169.254'],
  'mapped.test': ['::ffff:127.0.0.1'],
  'mixed.test': [PUBLIC, '192.168.1.10'],
  'mixed-last.test': ['192.168.1.10', PUBLIC],
  'v6.test': ['2606:4700:4700::1111'],
  'nat64.test': ['64:ff9b::7f00:1'],
};

function deps(extra?: { calls?: string[]; dialed?: string[] }): SafeFetchDeps {
  const resolve: Resolver = async (host) => {
    extra?.calls?.push(host);
    const list = NAMES[host];
    if (!list) throw new Error('ENOTFOUND');
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return {
    resolve,
    dial: (address) => {
      extra?.dialed?.push(address);
      return { host: '127.0.0.1', port };
    },
  };
}

const BASE: SafeFetchOptions = { maxBytes: 1024 * 1024, timeoutMs: 2000, maxRedirects: 3, overflow: 'truncate', accept: '*/*' };
const opts = (o: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({ ...BASE, ...o });

const ok = (body: string | Buffer, type = 'text/html'): ((req: IncomingMessage, res: ServerResponse) => void) => (_req, res) => {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
};
const redirectTo = (location: string, status = 302): ((req: IncomingMessage, res: ServerResponse) => void) => (_req, res) => {
  res.writeHead(status, { location });
  res.end();
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SafeFetchError) return err.code;
    throw err;
  }
  return 'no error';
}

describe('vetUrl', () => {
  it.each([
    ['http://example.test/a', 'http://example.test/a'],
    ['https://example.test:443/a', 'https://example.test/a'],
    ['http://example.test:80/a', 'http://example.test/a'],
    ['https://user:secret@example.test/a#frag', 'https://example.test/a'],
    ['http://EXAMPLE.test./a', 'http://example.test./a'],
    ['http://8.8.8.8/', 'http://8.8.8.8/'],
    ['http://[2606:4700:4700::1111]/', 'http://[2606:4700:4700::1111]/'],
  ])('accepts %s', (input, expected) => {
    expect(vetUrl(input).href).toBe(expected);
  });

  it.each([
    ['ftp://example.test/', 'blocked_scheme'],
    ['file:///etc/passwd', 'blocked_scheme'],
    ['gopher://example.test/', 'blocked_scheme'],
    ['javascript:alert(1)', 'blocked_scheme'],
    ['data:text/html,hi', 'blocked_scheme'],
    ['not a url', 'bad_url'],
    ['', 'bad_url'],
    ['http://example.test:8080/', 'blocked_port'],
    ['http://example.test:22/', 'blocked_port'],
    ['http://example.test:443/', 'blocked_port'],
    ['https://example.test:80/', 'blocked_port'],
    ['http://localhost/', 'blocked_host'],
    ['http://LOCALHOST./', 'blocked_host'],
    ['http://a.localhost/', 'blocked_host'],
    ['http://printer.local/', 'blocked_host'],
    ['http://db.internal/', 'blocked_host'],
    ['http://127.0.0.1/', 'blocked_address'],
    ['http://127.1/', 'blocked_address'],
    ['http://2130706433/', 'blocked_address'],
    ['http://0x7f000001/', 'blocked_address'],
    ['http://0177.0.0.1/', 'blocked_address'],
    ['http://0/', 'blocked_address'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['http://[::1]/', 'blocked_address'],
    ['http://[::ffff:127.0.0.1]/', 'blocked_address'],
    ['http://[::ffff:7f00:1]/', 'blocked_address'],
    ['http://[fe80::1]/', 'blocked_address'],
    ['http://[fd00::1]/', 'blocked_address'],
    ['http://10.1.2.3/', 'blocked_address'],
    ['http://100.64.1.1/', 'blocked_address'],
    ['http://192.168.0.1/', 'blocked_address'],
  ])('refuses %s as %s', (input, code) => {
    expect(() => vetUrl(input)).toThrowError(expect.objectContaining({ code }));
  });
});

describe('resolution and connection', () => {
  it('connects to the vetted address and sends the original name as Host', async () => {
    handler = ok('<title>x</title>');
    seen.length = 0;
    const dialed: string[] = [];
    const res = await safeFetch('http://example.test/page?q=1', opts(), deps({ dialed }));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('<title>x</title>');
    expect(dialed).toEqual([PUBLIC]);
    expect(seen[0]?.host).toBe('example.test');
    expect(seen[0]?.url).toBe('/page?q=1');
  });

  it('resolves a name exactly once per hop (no second lookup to rebind)', async () => {
    handler = ok('hi');
    const calls: string[] = [];
    await safeFetch('http://example.test/', opts(), deps({ calls }));
    expect(calls).toEqual(['example.test']);
  });

  it('connects an IPv6 literal that is public', async () => {
    handler = ok('hi');
    const dialed: string[] = [];
    await safeFetch('http://[2606:4700:4700::1111]/', opts(), deps({ dialed }));
    expect(dialed).toEqual(['2606:4700:4700::1111']);
  });

  it.each([
    ['private.test', 'blocked_address'],
    ['loop.test', 'blocked_address'],
    ['meta.test', 'blocked_address'],
    ['mapped.test', 'blocked_address'],
    ['nat64.test', 'blocked_address'],
    ['mixed.test', 'blocked_address'],
    ['mixed-last.test', 'blocked_address'],
    ['missing.test', 'dns_failed'],
  ])('refuses the name %s as %s and never connects', async (name, code) => {
    seen.length = 0;
    const dialed: string[] = [];
    expect(await codeOf(safeFetch(`http://${name}/`, opts(), deps({ dialed })))).toBe(code);
    expect(dialed).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('never sends credentials from the address', async () => {
    handler = ok('hi');
    seen.length = 0;
    await safeFetch('http://admin:hunter2@example.test/secret', opts(), deps());
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[0]?.host).toBe('example.test');
  });

  it('sends the plugin user agent', async () => {
    handler = ok('hi');
    seen.length = 0;
    await safeFetch('http://example.test/', opts(), deps());
    expect(seen[0]?.userAgent).toMatch(/ManythreadsLinkPreview/);
  });
});

describe('redirects', () => {
  it('follows a redirect to another public name, vetting it again', async () => {
    let n = 0;
    handler = (req, res) => (n++ === 0 ? redirectTo('http://other.test/final')(req, res) : ok('done')(req, res));
    seen.length = 0;
    const calls: string[] = [];
    const res = await safeFetch('http://example.test/', opts(), deps({ calls }));
    expect(res.body.toString()).toBe('done');
    expect(res.url.href).toBe('http://other.test/final');
    expect(res.redirects).toBe(1);
    expect(calls).toEqual(['example.test', 'other.test']);
  });

  it('resolves a relative redirect against the current address', async () => {
    let n = 0;
    handler = (req, res) => (n++ === 0 ? redirectTo('/moved')(req, res) : ok('done')(req, res));
    const res = await safeFetch('http://example.test/a/b', opts(), deps());
    expect(res.url.href).toBe('http://example.test/moved');
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['http://127.0.0.1/', 'blocked_address'],
    ['http://[::1]/', 'blocked_address'],
    ['http://[::ffff:a9fe:a9fe]/', 'blocked_address'],
    ['http://localhost/', 'blocked_host'],
    ['http://private.test/', 'blocked_address'],
    ['http://meta.test/', 'blocked_address'],
    ['http://mixed.test/', 'blocked_address'],
    ['http://example.test:8080/', 'blocked_port'],
    ['http://example.test:6379/', 'blocked_port'],
    ['ftp://example.test/', 'blocked_scheme'],
    ['file:///etc/passwd', 'blocked_scheme'],
    ['gopher://example.test/_x', 'blocked_scheme'],
  ])('refuses a redirect to %s as %s', async (target, code) => {
    handler = redirectTo(target);
    seen.length = 0;
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe(code);
    expect(seen).toHaveLength(1); // only the first hop was ever requested
  });

  it('follows three redirects and refuses the fourth', async () => {
    let n = 0;
    handler = (req, res) => (n++ < 3 ? redirectTo(`/r${n}`)(req, res) : ok('end')(req, res));
    const res = await safeFetch('http://example.test/', opts({ maxRedirects: 3 }), deps());
    expect(res.redirects).toBe(3);

    handler = (req, res) => redirectTo('/again')(req, res);
    expect(await codeOf(safeFetch('http://example.test/', opts({ maxRedirects: 3 }), deps()))).toBe('too_many_redirects');
  });

  it('refuses a redirect loop', async () => {
    handler = redirectTo('http://example.test/');
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe('too_many_redirects');
  });

  it.each([301, 302, 303, 307, 308])('follows status %i', async (status) => {
    let n = 0;
    handler = (req, res) => (n++ === 0 ? redirectTo('/x', status)(req, res) : ok('done')(req, res));
    const res = await safeFetch('http://example.test/', opts(), deps());
    expect(res.body.toString()).toBe('done');
  });

  it('refuses a redirect with no usable target', async () => {
    handler = (_req, res) => {
      res.writeHead(302);
      res.end();
    };
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe('bad_redirect');
    handler = redirectTo('http://');
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe('bad_redirect');
  });

  it('does not carry credentials a redirect target names', async () => {
    let n = 0;
    handler = (req, res) => (n++ === 0 ? redirectTo('http://user:pw@other.test/z')(req, res) : ok('done')(req, res));
    seen.length = 0;
    await safeFetch('http://example.test/', opts(), deps());
    expect(seen.every((s) => s.authorization === undefined)).toBe(true);
  });
});

describe('the caller check', () => {
  it('runs for the first address and for each redirect, before the request', async () => {
    let n = 0;
    handler = (req, res) => (n++ === 0 ? redirectTo('http://other.test/b')(req, res) : ok('done')(req, res));
    const checked: string[] = [];
    await safeFetch('http://example.test/a', opts({ check: (u) => void checked.push(u.href) }), deps());
    expect(checked).toEqual(['http://example.test/a', 'http://other.test/b']);
  });

  it('stops everything when it throws, and nothing is requested', async () => {
    handler = ok('hi');
    seen.length = 0;
    const code = await codeOf(
      safeFetch(
        'http://example.test/',
        opts({
          check: () => {
            throw new SafeFetchError('blocked_by_policy', 'no');
          },
        }),
        deps(),
      ),
    );
    expect(code).toBe('blocked_by_policy');
    expect(seen).toEqual([]);
  });

  it('can refuse a redirect target the first address passed', async () => {
    handler = redirectTo('http://other.test/b');
    seen.length = 0;
    const code = await codeOf(
      safeFetch(
        'http://example.test/a',
        opts({
          check: (u) => {
            if (u.hostname === 'other.test') throw new SafeFetchError('blocked_by_policy', 'denied');
          },
        }),
        deps(),
      ),
    );
    expect(code).toBe('blocked_by_policy');
    expect(seen).toHaveLength(1);
  });
});

describe('bounds', () => {
  it('truncates a long page at maxBytes', async () => {
    handler = ok(Buffer.alloc(50_000, 97));
    const res = await safeFetch('http://example.test/', opts({ maxBytes: 1000, overflow: 'truncate' }), deps());
    expect(res.body.length).toBe(1000);
    expect(res.truncated).toBe(true);
  });

  it('does not mark a short page truncated', async () => {
    handler = ok('short');
    const res = await safeFetch('http://example.test/', opts({ maxBytes: 1000 }), deps());
    expect(res.truncated).toBe(false);
  });

  it('refuses a long answer in fail mode by its declared length', async () => {
    handler = ok(Buffer.alloc(5000, 1), 'image/png');
    expect(await codeOf(safeFetch('http://example.test/', opts({ maxBytes: 1000, overflow: 'fail' }), deps()))).toBe('too_large');
  });

  it('refuses a long chunked answer in fail mode while it streams', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      for (let i = 0; i < 10; i += 1) res.write(Buffer.alloc(500, 1));
      res.end();
    };
    expect(await codeOf(safeFetch('http://example.test/', opts({ maxBytes: 1000, overflow: 'fail' }), deps()))).toBe('too_large');
  });

  it('counts a compressed answer after it is expanded (no zip bomb)', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 97));
    expect(bomb.length).toBeLessThan(100_000);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(bomb);
    };
    const res = await safeFetch('http://example.test/', opts({ maxBytes: 4096, overflow: 'truncate' }), deps());
    expect(res.body.length).toBe(4096);
    expect(await codeOf(safeFetch('http://example.test/', opts({ maxBytes: 4096, overflow: 'fail' }), deps()))).toBe('too_large');
  });

  it.each([
    ['gzip', (b: Buffer) => zlib.gzipSync(b)],
    ['deflate', (b: Buffer) => zlib.deflateSync(b)],
    ['br', (b: Buffer) => zlib.brotliCompressSync(b)],
  ])('decodes %s', async (encoding, pack) => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding });
      res.end(pack(Buffer.from('<title>packed</title>')));
    };
    const res = await safeFetch('http://example.test/', opts(), deps());
    expect(res.body.toString()).toBe('<title>packed</title>');
  });

  it('refuses an encoding it does not read', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'zstd' });
      res.end('x');
    };
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe('bad_encoding');
  });

  it('refuses a corrupt compressed body', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end('this is not gzip');
    };
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe('bad_encoding');
  });

  it('times out a server that never answers', async () => {
    handler = () => undefined;
    const started = Date.now();
    expect(await codeOf(safeFetch('http://example.test/', opts({ timeoutMs: 200 }), deps()))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('times out a server that drips bytes forever', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const timer = setInterval(() => res.write('x'), 20);
      res.on('close', () => clearInterval(timer));
    };
    const started = Date.now();
    expect(await codeOf(safeFetch('http://example.test/', opts({ timeoutMs: 300 }), deps()))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('keeps one clock across redirects', async () => {
    let n = 0;
    handler = (req, res) => {
      n += 1;
      if (n <= 3) setTimeout(() => redirectTo(`/r${n}`)(req, res), 120);
      else ok('late')(req, res);
    };
    const started = Date.now();
    expect(await codeOf(safeFetch('http://example.test/', opts({ timeoutMs: 300, maxRedirects: 5 }), deps()))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('refuses a status that is not a success', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('nope');
    };
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe('bad_status');
  });

  it('refuses a content type it was not asked for', async () => {
    handler = ok('{"a":1}', 'application/json');
    expect(await codeOf(safeFetch('http://example.test/', opts({ contentType: /^text\/html/ }), deps()))).toBe('bad_type');
    handler = ok('<p>', 'text/html; charset=utf-8');
    expect((await safeFetch('http://example.test/', opts({ contentType: /^text\/html/ }), deps())).status).toBe(200);
  });

  it('reports a refused connection as a network error', async () => {
    const dead: SafeFetchDeps = { resolve: deps().resolve, dial: () => ({ host: '127.0.0.1', port: 1 }) };
    expect(await codeOf(safeFetch('http://example.test/', opts(), dead))).toBe('network');
  });
});

describe('deflate: both the zlib and the raw form are read', () => {
  const page = Buffer.from('<title>packed</title>' + ' filler'.repeat(50));
  const serve = (body: Buffer): void => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'deflate' });
      res.end(body);
    };
  };

  it('reads a zlib stream (what the standard says "deflate" is)', async () => {
    serve(zlib.deflateSync(page));
    expect((await safeFetch('http://example.test/', opts(), deps())).body.equals(page)).toBe(true);
  });

  it('reads a raw stream (what many servers send as "deflate")', async () => {
    serve(zlib.deflateRawSync(page));
    expect((await safeFetch('http://example.test/', opts(), deps())).body.equals(page)).toBe(true);
  });

  it('reads a raw stream that arrives in small pieces', async () => {
    const raw = zlib.deflateRawSync(page);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'deflate' });
      res.write(raw.subarray(0, 1));
      setTimeout(() => res.end(raw.subarray(1)), 30);
    };
    expect((await safeFetch('http://example.test/', opts(), deps())).body.equals(page)).toBe(true);
  });

  it('an empty "deflate" body is an empty page, not a hang', async () => {
    serve(Buffer.alloc(0));
    const started = Date.now();
    const res = await safeFetch('http://example.test/', opts({ timeoutMs: 1500 }), deps()).catch((err: unknown) => err);
    expect(Date.now() - started).toBeLessThan(1400);
    if (res instanceof SafeFetchError) expect(['bad_encoding']).toContain(res.code);
    else expect((res as { body: Buffer }).body.length).toBe(0);
  });

  it('a bomb in either form is counted after it is expanded', async () => {
    for (const pack of [zlib.deflateSync, zlib.deflateRawSync]) {
      serve(pack(Buffer.alloc(20 * 1024 * 1024, 97)));
      const res = await safeFetch('http://example.test/', opts({ maxBytes: 4096, overflow: 'truncate' }), deps());
      expect(res.body.length).toBe(4096);
      expect(await codeOf(safeFetch('http://example.test/', opts({ maxBytes: 4096, overflow: 'fail' }), deps()))).toBe('too_large');
    }
  });

  it('a corrupt body in either form is a bad encoding', async () => {
    serve(Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe('bad_encoding');
    serve(Buffer.from([0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07]));
    expect(await codeOf(safeFetch('http://example.test/', opts(), deps()))).toBe('bad_encoding');
  });

  it('looksLikeZlib: method 8 and a header whose two bytes divide by 31', () => {
    expect(looksLikeZlib(zlib.deflateSync(page))).toBe(true);
    expect(looksLikeZlib(zlib.deflateSync(page, { level: 1 }))).toBe(true);
    expect(looksLikeZlib(zlib.deflateSync(page, { level: 9 }))).toBe(true);
    expect(looksLikeZlib(zlib.deflateRawSync(page))).toBe(false);
    expect(looksLikeZlib(Buffer.from([0x78]))).toBe(false);
    expect(looksLikeZlib(Buffer.alloc(0))).toBe(false);
    expect(looksLikeZlib(Buffer.from([0x78, 0x00]))).toBe(false);
    expect(looksLikeZlib(Buffer.from([0x79, 0x9c]))).toBe(false); // method nibble is not 8
  });
});

describe('one deadline for the whole job, and the name lookup gets the signal', () => {
  it('never runs past deadlineAt, whatever timeoutMs says', async () => {
    handler = () => undefined;
    const started = Date.now();
    expect(await codeOf(safeFetch('http://example.test/', opts({ timeoutMs: 10_000, deadlineAt: Date.now() + 250 }), deps()))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('a deadline already past is a timeout before anything is asked or sent', async () => {
    const calls: string[] = [];
    const before = seen.length;
    expect(await codeOf(safeFetch('http://example.test/', opts({ deadlineAt: Date.now() - 1 }), deps({ calls })))).toBe('timeout');
    expect(seen.length).toBe(before);
  });

  it('a deadline far away does not shorten timeoutMs', async () => {
    handler = () => undefined;
    const started = Date.now();
    expect(await codeOf(safeFetch('http://example.test/', opts({ timeoutMs: 200, deadlineAt: Date.now() + 60_000 }), deps()))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('hands the resolver an abort signal that fires when the clock runs out, and stops waiting for a name that never answers', async () => {
    let received: AbortSignal | undefined;
    const hanging: SafeFetchDeps = {
      resolve: (_host, signal) => {
        received = signal;
        return new Promise(() => undefined); // never answers
      },
      dial: () => ({ host: '127.0.0.1', port }),
    };
    const started = Date.now();
    expect(await codeOf(safeFetch('http://example.test/', opts({ timeoutMs: 200 }), hanging))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(received).toBeDefined();
    expect(received?.aborted).toBe(true);
  });

  it('a resolver that refuses because it is busy or cooling is a dns failure, not a crash', async () => {
    const { LookupRefused } = await import('../src/resolver.ts');
    const refusing = (reason: 'busy' | 'cooling'): SafeFetchDeps => ({
      resolve: async () => {
        throw new LookupRefused(reason);
      },
      dial: () => ({ host: '127.0.0.1', port }),
    });
    expect(await codeOf(safeFetch('http://example.test/', opts(), refusing('busy')))).toBe('dns_failed');
    expect(await codeOf(safeFetch('http://example.test/', opts(), refusing('cooling')))).toBe('dns_failed');
  });
});
