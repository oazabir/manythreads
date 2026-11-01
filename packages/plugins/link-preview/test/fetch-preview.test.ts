import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_LIMITS, OVERALL_MS, fetchPreview } from '../src/fetch-preview.ts';
import { createHostBreaker } from '../src/limits.ts';
import { SafeFetchError, type SafeFetchDeps } from '../src/safe-fetch.ts';

// One link from address to card, against a local fake server standing in for every public site (see safe-fetch.test.ts for how).

/** A PNG with a real header: the size it declares is read, so the fixture must say one (the bytes after the header are filler). */
const pngOf = (width: number, height: number, filler = 40): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, Buffer.from('IHDR'), ihdr, Buffer.alloc(filler, 7)]);
};
const PNG = pngOf(64, 64);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');

type Route = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let port = 0;
let routes: Record<string, Route> = {};
const requested: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = `${req.headers.host ?? ''}${req.url ?? ''}`;
    requested.push(key);
    (routes[key] ?? ((_q, r) => (r.writeHead(404), r.end())))(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const NAMES: Record<string, string> = {
  'site.test': '93.184.216.34',
  'cdn.test': '8.8.4.4',
  'internal.test': '10.1.1.1',
};
const deps: SafeFetchDeps = {
  resolve: async (host) => {
    const address = NAMES[host];
    if (!address) throw new Error('ENOTFOUND');
    return [{ address, family: 4 }];
  },
  dial: () => ({ host: '127.0.0.1', port }),
};

const html = (body: string): Route => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const bytes = (body: Buffer, type: string): Route => (_req, res) => {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
};
const json = (value: unknown): Route => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

const reset = (r: Record<string, Route>): void => {
  routes = r;
  requested.length = 0;
};

describe('fetchPreview', () => {
  it('builds a card from Open Graph tags and proxies the picture bytes', async () => {
    reset({
      'site.test/post': html(`<title>t</title><meta property="og:title" content="Hello"><meta property="og:description" content="World"><meta property="og:site_name" content="Site"><meta property="og:image" content="http://cdn.test/cover.png">`),
      'cdn.test/cover.png': bytes(PNG, 'image/png'),
    });
    const r = await fetchPreview('http://site.test/post', undefined, deps);
    expect(r).toMatchObject({ status: 'ok', title: 'Hello', description: 'World', siteName: 'Site', finalUrl: 'http://site.test/post' });
    expect(r.image?.type).toBe('image/png');
    expect(r.image?.bytes.equals(PNG)).toBe(true);
  });

  it('trusts the bytes, not the declared type: a page served as image/png is no picture', async () => {
    reset({
      'site.test/p': html(`<meta property="og:title" content="T"><meta property="og:image" content="http://cdn.test/x.png">`),
      'cdn.test/x.png': bytes(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'),
    });
    const r = await fetchPreview('http://site.test/p', undefined, deps);
    expect(r.status).toBe('ok');
    expect(r.image).toBeNull();
  });

  it('never keeps an SVG picture, whatever it is called', async () => {
    reset({
      'site.test/p': html(`<meta property="og:title" content="T"><meta property="og:image" content="http://cdn.test/x.svg">`),
      'cdn.test/x.svg': bytes(SVG, 'image/svg+xml'),
    });
    const r = await fetchPreview('http://site.test/p', undefined, deps);
    expect(r.status).toBe('ok');
    expect(r.image).toBeNull();
  });

  it('keeps the card when the picture is on a private address, and never requests it', async () => {
    reset({
      'site.test/p': html(`<meta property="og:title" content="T"><meta property="og:image" content="http://internal.test/secret.png">`),
      'internal.test/secret.png': bytes(PNG, 'image/png'),
    });
    const r = await fetchPreview('http://site.test/p', undefined, deps);
    expect(r.status).toBe('ok');
    expect(r.image).toBeNull();
    expect(requested).toEqual(['site.test/p']);
  });

  it('keeps the card when the picture is a raw address in the metadata aimed at the metadata service', async () => {
    reset({ 'site.test/p': html(`<meta property="og:title" content="T"><meta property="og:image" content="http://169.254.169.254/latest/meta-data/">`) });
    const r = await fetchPreview('http://site.test/p', undefined, deps);
    expect(r.status).toBe('ok');
    expect(r.image).toBeNull();
    expect(requested).toEqual(['site.test/p']);
  });

  it('judges the picture host with the same check as the page', async () => {
    reset({
      'site.test/p': html(`<meta property="og:title" content="T"><meta property="og:image" content="http://cdn.test/cover.png">`),
      'cdn.test/cover.png': bytes(PNG, 'image/png'),
    });
    const seen: string[] = [];
    const check = (u: URL): void => {
      seen.push(u.hostname);
      if (u.hostname === 'cdn.test') throw new SafeFetchError('blocked_by_policy', 'denied');
    };
    const r = await fetchPreview('http://site.test/p', check, deps);
    expect(seen).toEqual(['site.test', 'cdn.test']);
    expect(r.status).toBe('ok');
    expect(r.image).toBeNull();
    expect(requested).toEqual(['site.test/p']);
  });

  it('asks the oEmbed endpoint only when the tags leave a hole, and fills it', async () => {
    reset({
      'site.test/v': html(`<link rel="alternate" type="application/json+oembed" href="http://site.test/oembed?u=1">`),
      'site.test/oembed?u=1': json({ title: 'From oEmbed', author_name: 'Alex', provider_name: 'Vids', thumbnail_url: 'http://cdn.test/t.png', html: '<iframe src="//evil"></iframe>' }),
      'cdn.test/t.png': bytes(PNG, 'image/png'),
    });
    const r = await fetchPreview('http://site.test/v', undefined, deps);
    expect(r).toMatchObject({ status: 'ok', title: 'From oEmbed', description: 'Alex', siteName: 'Vids' });
    expect(r.image?.type).toBe('image/png');
    expect(JSON.stringify({ ...r, image: null })).not.toMatch(/iframe|evil/);
  });

  it('does not ask oEmbed when the page already has a title and a picture', async () => {
    reset({
      'site.test/v': html(`<meta property="og:title" content="T"><meta property="og:image" content="http://cdn.test/t.png"><link rel="alternate" type="application/json+oembed" href="http://site.test/oembed">`),
      'cdn.test/t.png': bytes(PNG, 'image/png'),
    });
    await fetchPreview('http://site.test/v', undefined, deps);
    expect(requested).not.toContain('site.test/oembed');
  });

  it('keeps the page card when the oEmbed read fails', async () => {
    reset({ 'site.test/v': html(`<meta property="og:description" content="D"><link rel="alternate" type="application/json+oembed" href="http://site.test/missing">`) });
    const r = await fetchPreview('http://site.test/v', undefined, deps);
    expect(r).toMatchObject({ status: 'ok', title: null, description: 'D' });
  });

  it('accepts a page that sends no content type', async () => {
    reset({
      'site.test/n': (_req, res) => {
        res.removeHeader('content-type');
        res.writeHead(200);
        res.end('<meta property="og:title" content="No type">');
      },
    });
    const r = await fetchPreview('http://site.test/n', undefined, deps);
    expect(r.title).toBe('No type');
  });

  it.each([
    ['a PDF', 'application/pdf'],
    ['a zip', 'application/zip'],
    ['an image', 'image/png'],
    ['plain text', 'text/plain'],
  ])('fails for %s without reading it as a page', async (_label, type) => {
    reset({ 'site.test/f': bytes(Buffer.from('<meta property="og:title" content="T">'), type) });
    const r = await fetchPreview('http://site.test/f', undefined, deps);
    expect(r).toMatchObject({ status: 'failed', reason: 'bad_type', title: null });
  });

  it('fails with no_metadata for a page that says nothing', async () => {
    reset({ 'site.test/e': html('<html><body>hello</body></html>') });
    expect(await fetchPreview('http://site.test/e', undefined, deps)).toMatchObject({ status: 'failed', reason: 'no_metadata' });
  });

  it('fails for an unknown page and reports blocked for a refused address', async () => {
    reset({});
    expect(await fetchPreview('http://site.test/missing', undefined, deps)).toMatchObject({ status: 'failed', reason: 'bad_status' });
    expect(await fetchPreview('http://internal.test/', undefined, deps)).toMatchObject({ status: 'blocked', reason: 'blocked_address' });
    expect(await fetchPreview('http://127.0.0.1/', undefined, deps)).toMatchObject({ status: 'blocked', reason: 'blocked_address' });
    expect(await fetchPreview('http://169.254.169.254/', undefined, deps)).toMatchObject({ status: 'blocked' });
    expect(await fetchPreview('ftp://site.test/', undefined, deps)).toMatchObject({ status: 'blocked', reason: 'blocked_scheme' });
    expect(await fetchPreview('http://nonexistent.test/', undefined, deps)).toMatchObject({ status: 'failed', reason: 'dns_failed' });
    expect(requested).toEqual(['site.test/missing']);
  });

  it('reports a policy refusal as blocked', async () => {
    reset({ 'site.test/p': html('<title>x</title>') });
    const check = (): void => {
      throw new SafeFetchError('blocked_by_policy', 'no');
    };
    expect(await fetchPreview('http://site.test/p', check, deps)).toMatchObject({ status: 'blocked', reason: 'blocked_by_policy' });
    expect(requested).toEqual([]);
  });

  it('never throws, whatever the check does', async () => {
    reset({ 'site.test/p': html('<title>x</title>') });
    const check = (): void => {
      throw new Error('boom');
    };
    expect(await fetchPreview('http://site.test/p', check, deps)).toMatchObject({ status: 'failed', reason: 'error' });
  });

  describe('pictures that are too big', () => {
    const page = html(`<meta property="og:title" content="T"><meta property="og:image" content="http://cdn.test/x.png">`);

    it('keeps the card and drops a picture that declares more than 4096 on a side, however small the file', async () => {
      const huge = pngOf(9000, 9000);
      expect(huge.length).toBeLessThan(100);
      reset({ 'site.test/p': page, 'cdn.test/x.png': bytes(huge, 'image/png') });
      const r = await fetchPreview('http://site.test/p', undefined, deps);
      expect(r).toMatchObject({ status: 'ok', title: 'T' });
      expect(r.image).toBeNull();
    });

    it('drops a picture of more than 16 million pixels even when no side is over the limit', async () => {
      reset({ 'site.test/p': page, 'cdn.test/x.png': bytes(pngOf(4096, 4000), 'image/png') });
      expect((await fetchPreview('http://site.test/p', undefined, deps)).image).toBeNull();
    });

    it('drops a picture whose header cannot be read', async () => {
      const noHeader = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
      reset({ 'site.test/p': page, 'cdn.test/x.png': bytes(noHeader, 'image/png') });
      const r = await fetchPreview('http://site.test/p', undefined, deps);
      expect(r.status).toBe('ok');
      expect(r.image).toBeNull();
    });

    it('allows at most 512 KiB for a picture: one byte over is no picture, exactly the limit is kept', async () => {
      expect(IMAGE_LIMITS.maxBytes).toBe(512 * 1024);
      const exact = pngOf(64, 64, IMAGE_LIMITS.maxBytes - pngOf(64, 64, 0).length);
      expect(exact.length).toBe(IMAGE_LIMITS.maxBytes);
      reset({ 'site.test/p': page, 'cdn.test/x.png': bytes(exact, 'image/png') });
      expect((await fetchPreview('http://site.test/p', undefined, deps)).image?.bytes.length).toBe(IMAGE_LIMITS.maxBytes);
      reset({ 'site.test/p': page, 'cdn.test/x.png': bytes(Buffer.concat([exact, Buffer.from([0])]), 'image/png') });
      expect((await fetchPreview('http://site.test/p', undefined, deps)).image).toBeNull();
    });
  });

  describe('a site that does not answer', () => {
    const stall: Route = () => undefined;

    it('is not asked again after three timeouts in a row: the fourth is answered without a request', async () => {
      const breaker = createHostBreaker({ threshold: 3, openMs: 60_000 });
      reset({ 'site.test/p': stall });
      const quick = { breaker, overallMs: 150 };
      for (let i = 0; i < 3; i += 1) {
        expect(await fetchPreview('http://site.test/p', undefined, deps, quick)).toMatchObject({ status: 'failed', reason: 'timeout' });
      }
      expect(requested).toHaveLength(3);
      expect(await fetchPreview('http://site.test/p', undefined, deps, quick)).toMatchObject({ status: 'failed', reason: 'host_cooling' });
      expect(requested).toHaveLength(3);
      // another host is not held back
      reset({ 'cdn.test/p': html('<title>fine</title>') });
      expect(await fetchPreview('http://cdn.test/p', undefined, deps, quick)).toMatchObject({ status: 'ok' });
    });

    it('does not count a missing page (404) as the site not answering', async () => {
      const breaker = createHostBreaker({ threshold: 2, openMs: 60_000 });
      reset({});
      for (let i = 0; i < 5; i += 1) await fetchPreview('http://site.test/missing', undefined, deps, { breaker });
      expect(requested).toHaveLength(5);
      expect(breaker.allow('site.test')).toBe(true);
    });

    it('a good answer clears the count', async () => {
      const breaker = createHostBreaker({ threshold: 2, openMs: 60_000 });
      reset({ 'site.test/slow': stall, 'site.test/ok': html('<title>ok</title>') });
      await fetchPreview('http://site.test/slow', undefined, deps, { breaker, overallMs: 100 });
      await fetchPreview('http://site.test/ok', undefined, deps, { breaker });
      await fetchPreview('http://site.test/slow', undefined, deps, { breaker, overallMs: 100 });
      expect(breaker.allow('site.test')).toBe(true);
    });

    it('ends the whole job by the overall time even when each read is allowed three seconds', async () => {
      expect(OVERALL_MS).toBeLessThanOrEqual(8000);
      reset({
        'site.test/p': html(`<meta property="og:title" content="T"><meta property="og:image" content="http://cdn.test/x.png">`),
        'cdn.test/x.png': stall,
      });
      const started = Date.now();
      const r = await fetchPreview('http://site.test/p', undefined, deps, { overallMs: 400 });
      // the card is kept without its picture, and the call did not wait for the picture's own three seconds
      expect(r).toMatchObject({ status: 'ok', title: 'T' });
      expect(r.image).toBeNull();
      expect(Date.now() - started).toBeLessThan(1500);
    });

    it('a deadline that has run out before the page is read fails with timeout and asks nobody', async () => {
      reset({ 'site.test/p': html('<title>x</title>') });
      expect(await fetchPreview('http://site.test/p', undefined, deps, { overallMs: 0 })).toMatchObject({ status: 'failed', reason: 'timeout' });
      expect(requested).toEqual([]);
    });
  });
});
