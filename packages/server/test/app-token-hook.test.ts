import { randomBytes } from 'node:crypto';
import { embeddedAppHeaders, repoAppTokenPath } from '@manythreads/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppTokens } from '../src/app-token.ts';
import { buildServer } from '../src/index.ts';

// The server's side of embedded-app tokens (PLAN P4-10), without a database: a token in the path of the app content route stands in for the
// session cookie for GET and HEAD under that route, only inside its folder and team, and nowhere else.

const ACTOR = '00000000-0000-7000-8000-000000000a01';
const WORKSPACE = '00000000-0000-7000-8000-0000000000a1';
const secret = randomBytes(32);
let now = Date.parse('2026-03-02T09:00:00Z');
const tokens = createAppTokens({ secret, now: () => new Date(now) });
const open: FastifyInstance[] = [];

async function server(): Promise<FastifyInstance> {
  const app = await buildServer({
    appTokens: { secret, now: () => new Date(now) },
    routes: (a) => {
      // stands in for the repo-git route: answers who the request is
      a.get('/api/teams/:slug/repo/app/*', (req) => ({ actor: req.actor?.id ?? null, kind: req.actor?.kind ?? null, workspace: req.actor?.workspaceId ?? null, rest: (req.params as Record<string, string>)['*'] }));
      a.post('/api/teams/:slug/repo/app/*', (req) => ({ actor: req.actor?.id ?? null }));
      a.get('/api/teams/:slug/repo/blob', (req) => ({ actor: req.actor?.id ?? null }));
    },
  });
  open.push(app);
  return app;
}
afterEach(async () => {
  now = Date.parse('2026-03-02T09:00:00Z');
  await Promise.all(open.splice(0).map((a) => a.close()));
});

const issue = (over: Partial<{ slug: string; folder: string }> = {}): string =>
  tokens.issue({ actorId: ACTOR, workspaceId: WORKSPACE, slug: over.slug ?? 'engineering', folder: over.folder ?? 'apps/release-checklist' }).token;
const urlOf = (token: string, slug = 'engineering', folder = 'apps/release-checklist', file = 'index.html'): string => repoAppTokenPath(slug, token, folder, file);

describe('app token in the content route', () => {
  it('without a token or a session the route answers 401 (and still carries the strict headers)', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/app/apps/release-checklist/index.html' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toBe(embeddedAppHeaders()['content-security-policy']);
  });

  it('a valid token makes the request that person\'s: the index page and a relative sub-resource', async () => {
    const app = await server();
    const token = issue();
    for (const file of ['index.html', '__manythreads.js', 'js/app.js']) {
      const res = await app.inject({ method: 'GET', url: urlOf(token, 'engineering', 'apps/release-checklist', file) });
      expect(res.statusCode, file).toBe(200);
      expect(res.json()).toMatchObject({ actor: ACTOR, kind: 'person', workspace: WORKSPACE });
      expect(res.headers['content-security-policy']).toContain("connect-src 'none'");
    }
    const head = await app.inject({ method: 'HEAD', url: urlOf(token) });
    expect(head.statusCode).toBe(200);
  });

  it('five minutes later the same address answers 403, and an hour later too', async () => {
    const app = await server();
    const token = issue();
    expect((await app.inject({ method: 'GET', url: urlOf(token) })).statusCode).toBe(200);
    now += 299_000;
    expect((await app.inject({ method: 'GET', url: urlOf(token) })).statusCode).toBe(200);
    now += 1_000;
    const expired = await app.inject({ method: 'GET', url: urlOf(token) });
    expect(expired.statusCode).toBe(403);
    expect(expired.json()).toEqual({ error: { code: 'forbidden', message: 'This app link has expired or is not valid. Reopen the app.' } });
    expect(expired.headers['content-security-policy']).toContain("default-src 'none'");
    now += 3_600_000;
    expect((await app.inject({ method: 'GET', url: urlOf(token) })).statusCode).toBe(403);
  });

  it('refuses another app, a path out of the folder and another team: the same 403 for each', async () => {
    const app = await server();
    const token = issue();
    const wrong = [
      urlOf(token, 'engineering', 'apps/other'), // another app
      urlOf(token, 'engineering', 'apps/release-checklist-2'), // same prefix, another folder
      urlOf(token, 'engineering', 'bots/coder', 'BOT.md'), // not an app
      urlOf(token, 'marketing', 'apps/release-checklist'), // another team, same folder name
      // a traversal the browser would have resolved, sent raw
      urlOf(token).replace('/apps/release-checklist/index.html', '/apps/release-checklist/../other/index.html'),
      urlOf(token).replace('/apps/release-checklist/index.html', '/apps/release-checklist/%2e%2e/other/index.html'),
      urlOf(token).replace('/apps/release-checklist/index.html', '/apps//release-checklist/index.html'),
    ];
    const bodies = new Set<string>();
    for (const url of wrong) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(403);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1); // expired, tampered, wrong scope: the client hears the same thing
  });

  it('refuses a tampered token, a token for nobody else\'s secret and a half-token', async () => {
    const app = await server();
    const token = issue();
    const flip = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await app.inject({ method: 'GET', url: urlOf(flip) })).statusCode).toBe(403);
    const foreign = createAppTokens({ secret: randomBytes(32), now: () => new Date(now) }).issue({ actorId: ACTOR, workspaceId: WORKSPACE, slug: 'engineering', folder: 'apps/release-checklist' }).token;
    expect((await app.inject({ method: 'GET', url: urlOf(foreign) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/app/~mta.v1/apps/release-checklist/index.html' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/teams/engineering/repo/app/~mta./apps/release-checklist/index.html' })).statusCode).toBe(403);
  });

  it('opens nothing else: not another route, not a write', async () => {
    const app = await server();
    const token = issue();
    // the token in the path of some other route is just a path
    expect((await app.inject({ method: 'GET', url: `/api/teams/engineering/repo/blob?path=${encodeURIComponent(`~mta.${token}`)}` })).statusCode).toBe(401);
    // a write under the app route is not authorised by it (no session: 401), whatever the token says
    const post = await app.inject({ method: 'POST', url: urlOf(token), payload: {} });
    expect(post.statusCode).toBe(401);
  });

  it('a valid token is the only way in: a stale one is refused even for a request that also carries an actor header', async () => {
    const app = await server();
    const token = issue();
    now += 301_000;
    const res = await app.inject({
      method: 'GET',
      url: urlOf(token),
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: ACTOR, workspaceId: WORKSPACE }) },
    });
    expect(res.statusCode).toBe(403);
  });
});
