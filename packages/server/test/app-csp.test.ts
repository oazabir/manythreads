import { EMBEDDED_APP_CSP, embeddedAppHeaders } from '@manythreads/shared';
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

const CSP = embeddedAppHeaders()['content-security-policy'];

describe('embedded app content route headers (PLAN P4-10)', () => {
  it('the policy forbids forms and a new base URL too', () => {
    expect(CSP).toContain("form-action 'none'");
    expect(CSP).toContain("base-uri 'none'");
    expect(CSP).toMatch(/; sandbox allow-scripts$/);
  });

  // C1 of the Phase 4 review: the router decodes the path before it matches, so a spelling the raw-URL check missed reached the handler with no CSP.
  it('no spelling of the path reaches the route without the policy: each is a 404 or carries CSP and sandbox', async () => {
    const app = await server();
    const spellings = [
      '/api/teams/engineering/repo/%61pp/apps/evil/index.html',
      '/api/teams/engineering/repo/ap%70/apps/evil/index.html',
      '/api/teams/engineering/repo/%41pp/apps/evil/index.html',
      '/api/teams/engineering/repo/%2561pp/apps/evil/index.html',
      '/api/teams/engineering/repo/App/apps/evil/index.html',
      '/api/teams/engineering/Repo/app/apps/evil/index.html',
      '/api/teams/engineering/repo/app%2Fapps/evil/index.html',
      '/api/teams/engineering//repo/app/apps/evil/index.html',
      '//api/teams/engineering/repo/app/apps/evil/index.html',
      '/api/teams/engineering/repo//app/apps/evil/index.html',
      '/api/teams/%65ngineering/repo/%61pp/apps/evil/index.html',
      '/api/teams/engineering/repo/app/apps/evil/index%2ehtml',
      '/api/teams/engineering/repo/app/apps/%65vil/index.html',
      '/api/teams/engineering/repo/app/?x=/repo/blob',
    ];
    for (const url of spellings) {
      const res = await app.inject({ method: 'GET', url });
      if (res.statusCode === 404) continue;
      expect(res.headers['content-security-policy'], url).toBe(CSP);
    }
    // the ones that DO decode onto the route are refused outright, not served
    for (const url of ['/api/teams/engineering/repo/%61pp/apps/evil/index.html', '/api/teams/engineering/repo/ap%70/apps/evil/index.html']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('every answer under /api/teams/:slug/repo/app/ carries the strict CSP', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/app/apps/release-checklist/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(embeddedAppHeaders()['content-security-policy']);
    expect(res.headers['content-security-policy']).toContain(EMBEDDED_APP_CSP);
    // opened directly (not in our frame) the file is an opaque origin too
    expect(res.headers['content-security-policy']).toMatch(/; sandbox allow-scripts$/);
    expect(res.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('a refusal or a missing file under the route carries it too', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/app/nope/missing.js?x=1' });
    expect(res.headers['content-security-policy']).toBe(embeddedAppHeaders()['content-security-policy']);
  });

  it('other routes are left alone', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/blob' });
    expect(res.headers['content-security-policy']).toBeUndefined();
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.headers['content-security-policy']).toBeUndefined();
  });
});
