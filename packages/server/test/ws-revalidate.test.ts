import { createRealtime } from '@manythreads/kernel';
import type { ActorId, PersonId, SessionId, WorkspaceId } from '@manythreads/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/build-server.ts';
import { DEFAULT_SESSION_CONFIG } from '../src/session/config.ts';
import type { SessionService } from '../src/session/service.ts';

// An open WebSocket must not outlive its session: sign-out, "sign out everywhere", an admin revoke, expiry and suspension all end the
// live stream within one revalidation interval (security review of phase 3: the socket used to stay open and keep receiving pushes).

const WS = '00000000-0000-7000-8000-000000000001' as WorkspaceId;
const PERSON = '00000000-0000-7000-8000-000000000002' as PersonId;
const ACTOR = '00000000-0000-7000-8000-000000000003' as ActorId;
const SESSION = '00000000-0000-7000-8000-000000000004' as SessionId;

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()));
});

function fakeSessions(liveIds: Set<string>): SessionService {
  return {
    config: { ...DEFAULT_SESSION_CONFIG, secureCookies: false },
    now: () => new Date(),
    resolve: (token: string) =>
      Promise.resolve(
        token === 'good-token'
          ? {
              ok: true as const,
              session: {
                sessionId: SESSION, personId: PERSON, workspaceId: WS, token, expiresAt: new Date(Date.now() + 60_000), rotated: null,
                actor: { kind: 'person' as const, id: ACTOR, workspaceId: WS },
              },
            }
          : { ok: false as const, reason: 'unknown' as const },
      ),
    live: (ids: readonly string[]) => Promise.resolve(new Set(ids.filter((id) => liveIds.has(id)))),
  } as unknown as SessionService;
}

const closed = (ws: { on(ev: 'close', fn: (code: number) => void): unknown }): Promise<number> => new Promise((resolve) => ws.on('close', resolve));

describe('/ws and session revocation', () => {
  it('closes a socket whose session is no longer live, and keeps one whose session is', async () => {
    const liveIds = new Set([SESSION as string]);
    const realtime = createRealtime();
    const app = await buildServer({ sessions: fakeSessions(liveIds), realtime, wsRevalidateMs: 40 });
    open.push(app);
    await app.ready();
    const ws = await app.injectWS('/ws', { headers: { cookie: 'manythreads_session=good-token' } });
    const done = closed(ws);
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.readyState).toBe(1);   // still live after several rounds
    expect(realtime.connections(PERSON)).toBe(1);
    liveIds.delete(SESSION);   // signed out / revoked / suspended / expired
    expect(await Promise.race([done, new Promise<number>((r) => setTimeout(() => r(-1), 1500))])).toBe(1008);
    for (let i = 0; i < 50 && realtime.connections(PERSON) > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(realtime.connections(PERSON)).toBe(0);
  });

  it('a socket without a session cookie is never tracked (it only answers pings and receives nothing)', async () => {
    const liveIds = new Set<string>();
    const realtime = createRealtime();
    const app = await buildServer({ sessions: fakeSessions(liveIds), realtime, wsRevalidateMs: 40 });
    open.push(app);
    await app.ready();
    const ws = await app.injectWS('/ws');
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.readyState).toBe(1);
    expect(realtime.connections()).toBe(0);
    ws.close();
  });
});

describe('/ws frame size', () => {
  it('closes a socket that sends a frame over 64 KiB (1009) and answers a normal ping', async () => {
    const app = await buildServer({ realtime: createRealtime() });
    open.push(app);
    await app.ready();
    const ws = await app.injectWS('/ws');
    const messages: string[] = [];
    ws.on('message', (d: Buffer) => void messages.push(d.toString()));
    ws.send(JSON.stringify({ type: 'ping', id: 'a', payload: {} }));
    for (let i = 0; i < 50 && messages.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(messages[0] ?? '{}')).toMatchObject({ type: 'pong', id: 'a' });
    const done = closed(ws);
    ws.send('x'.repeat(100 * 1024));
    expect(await Promise.race([done, new Promise<number>((r) => setTimeout(() => r(-1), 2000))])).toBe(1009);
  });
});

describe('SessionService.live (real database)', () => {
  it('is read only and says no for revoked, suspended, expired and idle sessions', async () => {
    const { createSystemPool, withSystem } = await import('@manythreads/kernel');
    const { createPersonas, startTestServer, NADIA, RAFI, OMAR } = await import('@manythreads/test-utils');
    const { createSessionService } = await import('../src/session/service.ts');
    const s = await startTestServer();
    try {
      await createPersonas(s.db);
      const pool = createSystemPool(s.db.systemUrl, 2);
      let now = new Date();
      const svc = createSessionService({ pool, config: { ...DEFAULT_SESSION_CONFIG, secureCookies: false }, now: () => now });
      const issue = (p: { personId: string; workspaceId: string }): Promise<string> =>
        withSystem(async (tx) => (await svc.issue(tx as never, { workspaceId: p.workspaceId, personId: p.personId, device: undefined } as never)).sessionId, { pool });
      const [a, b, c, d] = [await issue(NADIA), await issue(RAFI), await issue(OMAR), await issue(NADIA)];
      expect(await svc.live([a, b, c, d])).toEqual(new Set([a, b, c, d]));
      expect(await svc.live([])).toEqual(new Set());
      expect(await svc.live(['00000000-0000-7000-8000-00000000dead'])).toEqual(new Set());

      await withSystem(async (tx) => svc.revoke(tx as never, { sessionId: a, personId: NADIA.personId } as never), { pool });
      await withSystem((tx) => tx.query("UPDATE app.people SET status = 'suspended' WHERE id = $1", [RAFI.personId]), { pool });
      expect(await svc.live([a, b, c, d])).toEqual(new Set([c, d]));

      now = new Date(now.getTime() + DEFAULT_SESSION_CONFIG.idleMs + 1_000);   // nobody touched the sessions: idle now
      expect(await svc.live([c, d])).toEqual(new Set());
      await pool.end();
    } finally {
      await s.close();
    }
  }, 120_000);
});
