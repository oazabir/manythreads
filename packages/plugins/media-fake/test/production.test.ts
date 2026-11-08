import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin from '../src/index.ts';

// The fake media provider's two test routes (what the room's media server recorded; make a person "speak" to the room's listener) reach into every room of the server. They exist
// only in test servers, and even there answer 404 when NODE_ENV is production (PLAN P15 §10).

interface Registered {
  path: string;
  handler: (req: { body?: unknown; query?: unknown }, tx: unknown) => Promise<unknown>;
}

function load(): Registered[] {
  const routes: Registered[] = [];
  const ctx = {
    runtime: { now: () => new Date('2026-11-08T12:00:00Z') },
    providers: { register: () => undefined },
    http: { route: (r: Registered) => void routes.push(r) },
  };
  void plugin.register(ctx as never);
  return routes;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the media-fake test routes', () => {
  it('are two routes', () => {
    expect(load().map((r) => r.path).sort()).toEqual(['/api/test/media/speak', '/api/test/media/state']);
  });

  it('answer 404 in production and do not look at the request at all', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const r of load()) {
      // a request that would fail schema parsing with a 400 or a throw if the handler got that far: the refusal comes first
      await expect(r.handler({ body: undefined, query: undefined }, {}), r.path).rejects.toMatchObject({ status: 404 });
    }
  });

  it('do their work outside production (a state query for a room nobody opened is empty)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const state = load().find((r) => r.path === '/api/test/media/state')!;
    const res = (await state.handler({ query: { meetingId: '00000000-0000-7000-8000-000000000001' } }, {})) as { status: number; body: unknown };
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tokens: [], published: [], listeners: [], kicked: [] });
  });
});
