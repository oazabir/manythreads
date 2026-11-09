import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notFoundHandler } from '../src/errors.ts';
import { APP_CSP, MERMAID_CSP, registerWebStatic, safeJoin, webDirFromEnv } from '../src/web-static.ts';

describe('web-static', () => {
  let root: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mt-web-'));
    mkdirSync(join(root, 'assets'));
    mkdirSync(join(root, 'models'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>manythreads</title>');
    writeFileSync(join(root, 'assets', 'app.abc123.js'), 'console.log(1)');
    writeFileSync(join(root, 'models', 'm.wasm'), '\0asm');
    writeFileSync(join(root, 'sw.js'), 'self.addEventListener("fetch",()=>{})');
    writeFileSync(join(root, 'mermaid-sandbox.html'), '<!doctype html>');
    writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, '..secret'), 'no');
    app = Fastify();
    app.setNotFoundHandler(notFoundHandler);
    app.get('/api/ping', async () => ({ ok: true }));
    app.get('/healthz', async () => ({ status: 'ok' }));
    await registerWebStatic(app, root);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('is off unless the directory is named', () => {
    expect(webDirFromEnv({})).toBeNull();
    expect(webDirFromEnv({ MANYTHREADS_WEB_DIR: '  ' })).toBeNull();
    expect(webDirFromEnv({ MANYTHREADS_WEB_DIR: '/srv/web' })).toBe('/srv/web');
  });

  it('refuses a directory that is not a built client', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mt-web-empty-'));
    try {
      await expect(registerWebStatic(Fastify(), empty)).rejects.toThrow(/no index\.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('serves the app page at the root and at any address that is not a file, with the page policy', async () => {
    for (const url of ['/', '/t/engineering/chat', '/settings/workspace', '/does-not-exist.txt']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toBe('text/html; charset=utf-8');
      expect(res.headers['content-security-policy'], url).toBe(APP_CSP);
      expect(res.headers['cache-control'], url).toBe('no-cache');
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['permissions-policy'], url).toBe('microphone=(self), camera=(self)');
      expect(res.body, url).toContain('<title>manythreads</title>');
    }
  });

  it('answers HEAD without a body', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('serves files with their own type; assets and models are kept for good, the service worker is not', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/app.abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-security-policy']).toBeUndefined();
    expect(asset.body).toBe('console.log(1)');

    const model = await app.inject({ method: 'GET', url: '/models/m.wasm' });
    expect(model.headers['content-type']).toBe('application/wasm');
    expect(model.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const sw = await app.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.headers['cache-control']).toBe('no-cache');

    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    expect(icon.headers['content-length']).toBe(String(readFileSync(join(root, 'favicon.svg')).length));
  });

  it('gives the diagram frame its own policy', async () => {
    const res = await app.inject({ method: 'GET', url: '/mermaid-sandbox.html' });
    expect(res.headers['content-security-policy']).toBe(MERMAID_CSP);
  });

  it('answers a missing asset, model or service worker with a plain 404, never the app page', async () => {
    for (const url of ['/assets/gone.js', '/models/gone.onnx']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('<title>');
    }
  });

  it('keeps the server addresses: a route wins, an unknown address under them is a JSON 404', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/ping' })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
    for (const url of ['/api/nope', '/mcp', '/hooks/x/y', '/ws', '/readyz', '/metrics']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code, url).toBe('not_found');
    }
  });

  it('cannot be led out of the directory', async () => {
    expect(safeJoin(root, '../etc/passwd')).toBeNull();
    expect(safeJoin(root, '%2e%2e/etc/passwd')).toBeNull();
    expect(safeJoin(root, 'a%00b')).toBeNull();
    expect(safeJoin(root, '..\\x')).toBeNull();
    expect(safeJoin(root, '%zz')).toBeNull();
    expect(safeJoin(root, 'assets/app.abc123.js')).toBe(join(root, 'assets', 'app.abc123.js'));
    for (const url of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2f..%2fetc%2fpasswd']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('root:');
      expect([200, 404], url).toContain(res.statusCode);
    }
    // a file whose name merely starts with two dots is a file inside the directory
    const odd = await app.inject({ method: 'GET', url: '/..secret' });
    expect(odd.body).toBe('no');
  });

  it('uses the same policies as the web image', () => {
    const nginx = readFileSync(new URL('../../../deploy/docker/nginx.conf', import.meta.url), 'utf8');
    expect(nginx).toContain(`add_header Content-Security-Policy "${APP_CSP}" always;`);
    expect(nginx).toContain(`add_header Content-Security-Policy "${MERMAID_CSP}" always;`);
    expect(nginx).toContain('add_header Permissions-Policy "microphone=(self), camera=(self)" always;');
  });
});
