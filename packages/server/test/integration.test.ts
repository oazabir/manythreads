import { HealthResponse, KernelTestPingedEventV2, ReadyResponse } from '@majlis/shared';
import { readAs, startTestServer, OMAR, captureEvent, type TestServer } from '@majlis/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('server against a fresh database with the test plugin', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer();
  }, 60_000);
  afterAll(async () => {
    await s.close();
  });

  const actorHeader = { 'x-majlis-dev-actor': JSON.stringify({ kind: 'person', id: OMAR.actorId, workspaceId: OMAR.workspaceId }) };
  const get = (path: string) => fetch(s.url + path, { headers: actorHeader });
  const post = (path: string, body: unknown) =>
    fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...actorHeader }, body: JSON.stringify(body) });

  it('healthz and readyz report migrations and plugins', async () => {
    const health = HealthResponse.parse(await (await get('/healthz')).json());
        expect(health.migrations).toBeGreaterThanOrEqual(3);
    expect(health.plugins).toContain('test-kernel');
    expect(ReadyResponse.parse(await (await get('/readyz')).json()).migrations).toBe(health.migrations);
  });

  it('plugin route validates its strict body', async () => {
    const bad = await post('/plugins/test-kernel/api/test/echo', { message: '', extra: 1 });
    expect(bad.status).toBe(400);
    const good = await post('/plugins/test-kernel/api/test/echo', { message: 'hi' });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ echoed: 'hi', count: 1 });
  });

  it('ping emits one event and the subscriber records exactly one delivery', async () => {
    const note = `n-${Date.now()}`;
    const event = await captureEvent('kernel.test.pinged', async () => {
      const res = await post('/plugins/test-kernel/api/test/ping', { workspaceId: OMAR.workspaceId, note });
      expect(res.status).toBe(200);
    }, { pool: s.pools.system });
    expect(event.payload).toMatchObject({ note });
    let deliveries: unknown[] = [];
    for (let i = 0; i < 100 && deliveries.length === 0; i++) {
      deliveries = ((await (await get(`/plugins/test-kernel/api/test/deliveries?note=${note}`)).json()) as { deliveries: unknown[] }).deliveries;
      if (deliveries.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 600)); // would a duplicate delivery have arrived by now?
    deliveries = ((await (await get(`/plugins/test-kernel/api/test/deliveries?note=${note}`)).json()) as { deliveries: unknown[] }).deliveries;
    expect(deliveries).toHaveLength(1);
    expect(KernelTestPingedEventV2.parse(deliveries[0]).note).toBe(note);
  });

  it('readAs runs as a persona under RLS', async () => {
    const n = await readAs(OMAR, async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.events')).rows[0]?.n ?? -1, { pool: s.pools.app });
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
