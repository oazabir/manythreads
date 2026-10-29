import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpRouteDefinition, PluginContext } from '@manythreads/sdk';
import type { Monitor } from '../src/monitor.ts';
import { MIN_TOKEN_LENGTH, METRICS_PATH, bearerOf, registerRoutes, tokenMatches } from '../src/routes.ts';
import { healthy } from './fixtures.ts';

describe('bearerOf and tokenMatches', () => {
  it('reads a bearer credential', () => {
    expect(bearerOf('Bearer abc123')).toBe('abc123');
    expect(bearerOf('bearer   abc123  ')).toBe('abc123');
    expect(bearerOf('Basic abc')).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
    expect(bearerOf('Bearer')).toBeNull();
  });
  it('compares tokens exactly', () => {
    expect(tokenMatches('a'.repeat(40), 'a'.repeat(40))).toBe(true);
    expect(tokenMatches('a'.repeat(40), 'a'.repeat(39) + 'b')).toBe(false);
    expect(tokenMatches('', 'a'.repeat(40))).toBe(false);
  });
});

describe('GET /metrics', () => {
  const TOKEN = 't'.repeat(MIN_TOKEN_LENGTH + 8);
  let saved: string | undefined;
  let metrics: HttpRouteDefinition;

  beforeEach(() => {
    saved = process.env['MANYTHREADS_METRICS_TOKEN'];
    const routes: HttpRouteDefinition[] = [];
    const ctx = {
      http: { route: (d: HttpRouteDefinition) => void routes.push(d) },
      storage: { get: async () => undefined },
      runtime: { now: () => new Date('2026-10-29T08:00:00Z') },
      db: { system: async () => '00000000-0000-4000-8000-000000000001' },
    } as unknown as PluginContext;
    const monitor: Monitor = { measure: async () => ({ snapshot: healthy(), sections: { outbox: true } }) };
    registerRoutes(ctx, monitor, {});
    metrics = routes.find((r) => r.path === METRICS_PATH) as HttpRouteDefinition;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['MANYTHREADS_METRICS_TOKEN'];
    else process.env['MANYTHREADS_METRICS_TOKEN'] = saved;
  });

  const call = (authorization?: string) =>
    Promise.resolve(metrics.handler!({ params: {}, query: {}, body: undefined, headers: authorization ? { authorization } : {}, ip: '127.0.0.1', caller: null }, {} as never));

  it('is a public route (no session) that guards itself and is rate limited', () => {
    expect(metrics.method).toBe('GET');
    expect(metrics.public).toBe(true);
    expect(metrics.rateLimit).toBeDefined();
  });

  it('does not exist (404) while no token is configured', async () => {
    delete process.env['MANYTHREADS_METRICS_TOKEN'];
    await expect(call(`Bearer ${TOKEN}`)).rejects.toMatchObject({ status: 404 });
  });

  it('does not exist while the token is too short to be safe', async () => {
    process.env['MANYTHREADS_METRICS_TOKEN'] = 'short';
    await expect(call('Bearer short')).rejects.toMatchObject({ status: 404 });
  });

  it('answers 401 without the token or with a wrong one', async () => {
    process.env['MANYTHREADS_METRICS_TOKEN'] = TOKEN;
    expect((await call()).status).toBe(401);
    expect((await call('Bearer nope')).status).toBe(401);
    expect((await call(`Bearer ${TOKEN}x`)).status).toBe(401);
    expect((await call(`Basic ${TOKEN}`)).status).toBe(401);
    expect((await call()).headers?.['www-authenticate']).toMatch(/Bearer/);
  });

  it('serves the Prometheus text with the right token', async () => {
    process.env['MANYTHREADS_METRICS_TOKEN'] = TOKEN;
    const res = await call(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(String(res.body)).toContain('manythreads_outbox_oldest_age_seconds 0');
    expect(String(res.body)).toContain('manythreads_run_slots_limit 6');
  });
});
