import type { HttpRouteDefinition, PluginContext } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerReplayRoutes } from '../src/replay.ts';

// P7-07: the free replay is the route the server opens READ ONLY, so even a mistake inside it cannot write a row (the database refuses it, see the kernel's read-only test).
// The full replay is the one that starts a rehearsal, so it is an ordinary route.

describe('the routes of the replay', () => {
  const routes: HttpRouteDefinition[] = [];
  registerReplayRoutes({ http: { route: (d: HttpRouteDefinition) => void routes.push(d) } } as unknown as PluginContext);

  it('registers the free replay as a read-only GET and the full replay as a rate-limited POST', () => {
    const free = routes.find((r) => r.method === 'GET' && r.path.endsWith('/replay'));
    const paid = routes.find((r) => r.method === 'POST' && r.path.endsWith('/full'));
    expect(free?.readOnly).toBe(true);
    expect(free?.rateLimit).toBeDefined();
    expect(paid?.readOnly).toBeUndefined();
    expect(paid?.rateLimit).toBeDefined();
    expect(routes).toHaveLength(2);
  });

  it('takes a strict body on the full replay, so a message cannot be sent in', () => {
    const paid = routes.find((r) => r.method === 'POST')!;
    const confirm = { tokens: 10, token: 'a1b2c3d4e5f60718' };
    expect(paid.schema?.body?.safeParse({ confirm }).success).toBe(true);
    // the number alone is no confirmation
    expect(paid.schema?.body?.safeParse({ confirm: { tokens: 10 } }).success).toBe(false);
    expect(paid.schema?.body?.safeParse({ confirm, text: 'hi' }).success).toBe(false);
  });
});
