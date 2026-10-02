import { EMBEDDED_APP_CSP } from '@manythreads/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.ts';

const open: FastifyInstance[] = [];
async function server(): Promise<FastifyInstance> {
  const app = await buildServer({
    routes: (a) => {
      a.get('/api/teams/:slug/repo/app/*', { config: { public: true } }, (_req, reply) => reply.type('text/html').send('<p>app</p>'));
      a.get('/api/teams/:slug/repo/blob', { config: { public: true } }, () => ({ ok: true }));
    },
  });
  open.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()));
});

describe('embedded app content route headers (PLAN P4-10)', () => {
  it('every answer under /api/teams/:slug/repo/app/ carries the strict CSP', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/app/apps/release-checklist/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(EMBEDDED_APP_CSP);
    expect(res.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('a refusal or a missing file under the route carries it too', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/app/nope/missing.js?x=1' });
    expect(res.headers['content-security-policy']).toBe(EMBEDDED_APP_CSP);
  });

  it('other routes are left alone', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/blob' });
    expect(res.headers['content-security-policy']).toBeUndefined();
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.headers['content-security-policy']).toBeUndefined();
  });
});
