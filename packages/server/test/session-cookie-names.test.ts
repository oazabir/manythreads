import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { authenticateCookie, csrfAllows, finishSessionCookies } from '../src/session/authenticate.ts';
import { cookieNames, DEFAULT_SESSION_CONFIG, type SessionConfig } from '../src/session/config.ts';
import { clearSessionCookies, setSessionCookies } from '../src/session/cookies.ts';
import type { SessionService } from '../src/session/service.ts';
import { csrfTokenFor } from '../src/session/tokens.ts';

const TOKEN = 'tok-abc';
const CSRF = csrfTokenFor(TOKEN);

function fakeSessions(secure: boolean): SessionService {
  const config: SessionConfig = { ...DEFAULT_SESSION_CONFIG, secureCookies: secure };
  return {
    config,
    resolve: async (t: string) =>
      t === TOKEN
        ? { ok: true, session: { sessionId: 's1', personId: 'p1', workspaceId: 'w1', actor: { kind: 'person' }, token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000), rotated: null } }
        : { ok: false },
  } as unknown as SessionService;
}

async function build(secure: boolean): Promise<FastifyInstance> {
  const sessions = fakeSessions(secure);
  const app = Fastify();
  await app.register(cookie);
  app.decorateRequest('actor', null);
  app.decorateRequest('authSession', null);
  app.decorateRequest('staleSessionCookie', false);
  app.addHook('onRequest', async (req, reply) => authenticateCookie(req, reply, sessions));
  app.addHook('onSend', async (req, reply) => finishSessionCookies(req, reply, sessions));
  app.post('/write', async (req, reply) => (csrfAllows(req) ? { ok: true, who: req.authSession?.personId ?? null } : reply.code(403).send({ error: 'csrf' })));
  app.post('/in', async (_req, reply) => {
    setSessionCookies(reply, { sessionId: 's1', token: TOKEN, csrfToken: CSRF, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, sessions.config);
    return { ok: true };
  });
  app.post('/out', async (_req, reply) => {
    clearSessionCookies(reply, sessions.config);
    return { ok: true };
  });
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const setCookies = (res: { headers: Record<string, unknown> }): string[] => {
  const h = res.headers['set-cookie'];
  return Array.isArray(h) ? (h as string[]) : typeof h === 'string' ? [h] : [];
};

describe('cookie names', () => {
  it('Secure cookies carry the __Host- prefix, plain http keeps the plain names', () => {
    expect(cookieNames(true)).toEqual({ session: '__Host-manythreads_session', csrf: '__Host-manythreads_csrf' });
    expect(cookieNames(false)).toEqual({ session: 'manythreads_session', csrf: 'manythreads_csrf' });
  });

  it('sign-in sets the __Host- pair (Secure, Path=/, no Domain) and expires the legacy pair', async () => {
    app = await build(true);
    const res = await app.inject({ method: 'POST', url: '/in' });
    const c = setCookies(res);
    const session = c.find((x) => x.startsWith('__Host-manythreads_session='));
    const csrf = c.find((x) => x.startsWith('__Host-manythreads_csrf='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/Path=\//);
    expect(session).not.toMatch(/Domain=/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/Secure/i);
    expect(c.find((x) => x.startsWith('manythreads_session=;'))).toBeDefined();
    expect(c.find((x) => x.startsWith('manythreads_csrf=;'))).toBeDefined();
  });

  it('insecure config sets the plain names only', async () => {
    app = await build(false);
    const c = setCookies(await app.inject({ method: 'POST', url: '/in' }));
    expect(c.map((x) => x.split('=')[0]).sort()).toEqual(['manythreads_csrf', 'manythreads_session']);
    const out = setCookies(await app.inject({ method: 'POST', url: '/out' }));
    expect(out.map((x) => x.split('=')[0]).sort()).toEqual(['manythreads_csrf', 'manythreads_session']);
  });

  it('sign-out clears both pairs when Secure', async () => {
    app = await build(true);
    const c = setCookies(await app.inject({ method: 'POST', url: '/out' })).map((x) => x.split('=')[0]);
    expect(c.sort()).toEqual(['__Host-manythreads_csrf', '__Host-manythreads_session', 'manythreads_csrf', 'manythreads_session']);
  });
});

describe('CSRF with the new names', () => {
  it('accepts the __Host- csrf cookie + header, refuses a mismatch or a missing header', async () => {
    app = await build(true);
    const cookies = `__Host-manythreads_session=${TOKEN}; __Host-manythreads_csrf=${CSRF}`;
    const ok = await app.inject({ method: 'POST', url: '/write', headers: { cookie: cookies, 'x-csrf-token': CSRF } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ who: 'p1' });
    expect((await app.inject({ method: 'POST', url: '/write', headers: { cookie: cookies } })).statusCode).toBe(403);
    const forged = `__Host-manythreads_session=${TOKEN}; __Host-manythreads_csrf=forged`;
    expect((await app.inject({ method: 'POST', url: '/write', headers: { cookie: forged, 'x-csrf-token': 'forged' } })).statusCode).toBe(403);
  });

  it('on a Secure server a plain-named csrf cookie does not satisfy a __Host- session', async () => {
    app = await build(true);
    const cookies = `__Host-manythreads_session=${TOKEN}; manythreads_csrf=${CSRF}`;
    expect((await app.inject({ method: 'POST', url: '/write', headers: { cookie: cookies, 'x-csrf-token': CSRF } })).statusCode).toBe(403);
  });

  it('insecure config uses the plain names', async () => {
    app = await build(false);
    const cookies = `manythreads_session=${TOKEN}; manythreads_csrf=${CSRF}`;
    expect((await app.inject({ method: 'POST', url: '/write', headers: { cookie: cookies, 'x-csrf-token': CSRF } })).statusCode).toBe(200);
  });
});

describe('legacy plain-named cookies on a Secure server', () => {
  it('are never read as a session (a subdomain could have tossed them), and are cleared', async () => {
    app = await build(true);
    const cookies = `manythreads_session=${TOKEN}; manythreads_csrf=${CSRF}`;
    const res = await app.inject({ method: 'POST', url: '/write', headers: { cookie: cookies, 'x-csrf-token': CSRF } });
    expect(res.json()).toMatchObject({ who: null });
    expect(setCookies(res)).toEqual([]);
  });
});
