import { WsErrorEnvelope, ErrorEnvelope } from '@majlis/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildServer, DEV_ACTOR_HEADER } from '../src/index.ts';
import { devAuthEnabled, parseDevActor } from '../src/dev-actor.ts';

const open: FastifyInstance[] = [];
async function server(opts: Parameters<typeof buildServer>[0] = {}): Promise<FastifyInstance> {
  const app = await buildServer({ ...opts, routes: (a) => {
    const t = a.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
    t.post('/t/echo', { config: { public: true }, schema: { params: z.object({}), body: z.strictObject({ name: z.string().min(2), tags: z.array(z.number()).optional() }), response: { 200: z.object({ name: z.string() }) } } },
      (req) => ({ name: req.body.name }));
    t.get('/t/bad-response', { config: { public: true }, schema: { response: { 200: z.object({ n: z.number() }) } } },
      () => ({ n: 'not a number' }) as never);
    t.get('/t/limited', { config: { public: true, rateLimit: { limit: 5, windowMs: 60_000 } } }, () => ({ ok: true }));
    t.get('/t/private', {}, () => ({ ok: true }));
    t.get('/t/boom', { config: { public: true } }, () => { throw new Error('db password is hunter2'); });
    return opts.routes?.(a);
  } });
  open.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()));
});

const parseEnvelope = (body: string) => ErrorEnvelope.parse(JSON.parse(body));

describe('validation and error envelope', () => {
  it('bad body gives 400 validation_failed with the field path', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/t/echo', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
    const env = parseEnvelope(res.body);
    expect(env.error.code).toBe('validation_failed');
    expect(env.error.path).toEqual(['name']);
    expect(env.error.details?.[0]?.path).toEqual(['name']);
  });

  it('nested paths use numeric indexes; unknown keys are rejected', async () => {
    const app = await server();
    const nested = await app.inject({ method: 'POST', url: '/t/echo', payload: { name: 'ok', tags: [1, 'x'] } });
    expect(parseEnvelope(nested.body).error.path).toEqual(['tags', 1]);
    const extra = await app.inject({ method: 'POST', url: '/t/echo', payload: { name: 'ok', extra: 1 } });
    expect(extra.statusCode).toBe(400);
  });

  it('good body gives 200', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/t/echo', payload: { name: 'ok' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'ok' });
  });

  it('a response failing its schema is a 500 envelope without detail', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/t/bad-response' });
    expect(res.statusCode).toBe(500);
    expect(parseEnvelope(res.body).error.code).toBe('internal');
  });

  it('404 and 500 use the envelope and do not leak messages', async () => {
    const app = await server();
    const nf = await app.inject({ method: 'GET', url: '/nope' });
    expect(nf.statusCode).toBe(404);
    expect(parseEnvelope(nf.body).error.code).toBe('not_found');
    const boom = await app.inject({ method: 'GET', url: '/t/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain('hunter2');
  });

  it('malformed JSON is a 400 envelope', async () => {
    const app = await server();
    const res = await app.inject({ method: 'POST', url: '/t/echo', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(res.statusCode).toBe(400);
    expect(parseEnvelope(res.body).error.code).toBe('validation_failed');
  });
});

describe('actors', () => {
  const actor = { kind: 'person', id: '00000000-0000-7000-8000-0000000d0001', workspaceId: '00000000-0000-7000-8000-00000000a001' };
  it('non-public routes need an actor; the dev header works only when enabled', async () => {
    const on = await server({ devAuth: true });
    expect((await on.inject({ method: 'GET', url: '/t/private' })).statusCode).toBe(401);
    const ok = await on.inject({ method: 'GET', url: '/t/private', headers: { [DEV_ACTOR_HEADER]: JSON.stringify(actor) } });
    expect(ok.statusCode).toBe(200);
    const off = await server({ devAuth: false });
    const denied = await off.inject({ method: 'GET', url: '/t/private', headers: { [DEV_ACTOR_HEADER]: JSON.stringify(actor) } });
    expect(denied.statusCode).toBe(401);
    expect(parseEnvelope(denied.body).error.code).toBe('unauthenticated');
  });
});

describe('dev auth gating', () => {
  const actor = JSON.stringify({ kind: 'person', id: '00000000-0000-7000-8000-0000000d0001', workspaceId: '00000000-0000-7000-8000-00000000a001' });
  afterEach(() => vi.unstubAllEnvs());

  it('is enabled only by NODE_ENV=test or MAJLIS_DEV_AUTH=1', () => {
    expect(devAuthEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(devAuthEnabled({})).toBe(false);
    expect(devAuthEnabled({ MAJLIS_DEV_AUTH: '0' })).toBe(false);
    expect(devAuthEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(devAuthEnabled({ NODE_ENV: 'production', MAJLIS_DEV_AUTH: '1' })).toBe(true);
  });

  it('a production server with default options ignores the header', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MAJLIS_DEV_AUTH', '');
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/t/private', headers: { [DEV_ACTOR_HEADER]: actor } });
    expect(res.statusCode).toBe(401);
  });

  it('the header can never claim the system actor', () => {
    const system = JSON.stringify({ kind: 'system', id: '00000000-0000-0000-0000-000000000000', workspaceId: '00000000-0000-0000-0000-000000000000' });
    expect(parseDevActor(system)).toBeNull();
    expect(parseDevActor(actor)).not.toBeNull();
  });
});

describe('rate limiting', () => {
  it('429 rate_limited after the limit, with retry-after', async () => {
    const app = await server();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await app.inject({ method: 'GET', url: '/t/limited' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
    const res = await app.inject({ method: 'GET', url: '/t/limited' });
    expect(parseEnvelope(res.body).error.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counters are per replica: two servers each allow the full limit (criterion 7)', async () => {
    const [a, b] = [await server(), await server()];
    const run = async (app: FastifyInstance): Promise<number[]> => {
      const out: number[] = [];
      for (let i = 0; i < 7; i++) out.push((await app.inject({ method: 'GET', url: '/t/limited' })).statusCode);
      return out;
    };
    const [ra, rb] = [await run(a), await run(b)];
    expect(ra.filter((c) => c === 200)).toHaveLength(5);
    expect(rb.filter((c) => c === 200)).toHaveLength(5);
    expect(ra.filter((c) => c === 429)).toHaveLength(2);
    expect(rb.filter((c) => c === 429)).toHaveLength(2);
  });
});

describe('openapi and websocket', () => {
  it('/openapi.json describes routes from their Zod schemas', async () => {
    const app = await server();
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toContain('/t/echo');
    expect(Object.keys(doc.paths)).toContain('/healthz');
    expect(Object.keys(doc.paths)).not.toContain('/openapi.json');
  });

  it('/ws validates envelopes both ways', async () => {
    const app = await server();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: unknown[] = [];
    ws.onmessage = (e) => void messages.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws failed'));
    });
    ws.send(JSON.stringify({ type: 'ping', id: 'p1', payload: { n: 1 } }));
    for (let i = 0; i < 50 && messages.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    ws.send(JSON.stringify({ type: 'ping', payload: {} }));
    for (let i = 0; i < 50 && messages.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    expect(messages[0]).toEqual({ type: 'pong', id: 'p1', payload: { n: 1 } });
    const err = WsErrorEnvelope.parse(messages[1]);
    expect(err.payload.code).toBe('validation_failed');
  });
});
