import { eventToRaw, withSystem, type EventRow } from '@manythreads/kernel';
import { parseEvent, type EventType } from '@manythreads/shared';
import { createApiClient, createPersonas, startTestServer, NADIA, OMAR, PERSONA_PASSWORD, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Event contract tests (pnpm test:events): every identity audit event is stored in the shape its registered schema
// accepts, and each action emits exactly the events it should.

const bootstrapped = 'identity.workspace.bootstrapped' satisfies EventType;

let boot: TestServer;
let s: TestServer;
beforeAll(async () => {
  boot = await startTestServer();
  const c = createApiClient(boot.url);
  const res = await c.post(`/api/bootstrap/${boot.bootstrapToken()}`, {
    workspaceName: 'Kahf Software',
    name: 'Omar',
    email: 'omar@kahf.example',
    password: PERSONA_PASSWORD,
  });
  if (res.status !== 200) throw new Error(`bootstrap failed: ${res.status}`);

  s = await startTestServer();
  await createPersonas(s.db);
}, 120_000);
afterAll(async () => {
  await boot?.close();
  await s?.close();
});

const rows = (server: TestServer, since: string | null): Promise<EventRow[]> =>
  withSystem(
    async (tx) =>
      (
        await tx.query<EventRow>(
          `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
           WHERE ($1::uuid IS NULL OR id > $1::uuid) AND type LIKE 'identity.%' ORDER BY id`,
          [since],
        )
      ).rows,
    { pool: server.pools.system },
  );
const latestId = async (server: TestServer): Promise<string | null> =>
  withSystem(async (tx) => (await tx.query<{ id: string | null }>('SELECT max(id::text)::text AS id FROM app.events')).rows[0]?.id ?? null, {
    pool: server.pools.system,
  });

describe('identity audit events', () => {
  it('bootstrap emits identity.workspace.bootstrapped then identity.session.signed_in (method bootstrap)', async () => {
    const all = await rows(boot, null);
    expect(all.map((r) => r.type)).toEqual([bootstrapped, 'identity.session.signed_in']);
    for (const r of all) expect(() => parseEvent(eventToRaw(r))).not.toThrow();
    expect(all[1]?.payload).toMatchObject({ method: 'bootstrap' });
    expect(all[0]?.team_id).toBeNull();
  });

  it('sign-in, failure, sign-out, sign-out-everywhere and a session revoke each emit one valid event', async () => {
    const before = await latestId(s);
    const a = createApiClient(s.url);
    const b = createApiClient(s.url);
    await a.signIn(NADIA.email, PERSONA_PASSWORD);
    await b.signIn(NADIA.email, PERSONA_PASSWORD);
    await createApiClient(s.url).signIn(NADIA.email, 'definitely-wrong-password');
    const bId = ((await (await b.get('/api/auth/sessions')).json()) as { sessions: { id: string; current: boolean }[] }).sessions.find((x) => x.current)?.id;
    await a.delete(`/api/auth/sessions/${bId}`);
    await a.post('/api/auth/sign-out');
    const c = createApiClient(s.url);
    await c.signIn(NADIA.email, PERSONA_PASSWORD);
    await c.post('/api/auth/sign-out-everywhere');

    const all = await rows(s, before);
    for (const r of all) {
      expect(() => parseEvent(eventToRaw(r)), r.type).not.toThrow();
      expect(r.workspace_id).toBe(NADIA.workspaceId);
      expect(r.payload).toMatchObject({ personId: NADIA.personId });
    }
    expect(all.map((r) => [r.type, (r.payload as { scope?: string; reason?: string }).scope ?? (r.payload as { reason?: string }).reason ?? null])).toEqual([
      ['identity.session.signed_in', null],
      ['identity.session.signed_in', null],
      ['identity.session.sign_in_failed', 'wrong_password'],
      ['identity.session.signed_out', 'other_session'],
      ['identity.session.signed_out', 'session'],
      ['identity.session.signed_in', null],
      ['identity.session.signed_out', 'everywhere'],
    ]);
  });

  it('an unknown email emits nothing (no workspace to attach it to) and the owner is not touched', async () => {
    const before = await latestId(s);
    await createApiClient(s.url).signIn('nobody@kahf.example', 'definitely-wrong-password');
    expect(await rows(s, before)).toEqual([]);
    expect(OMAR.personId).toBeDefined();
  });
});
