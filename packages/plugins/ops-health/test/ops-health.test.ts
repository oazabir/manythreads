import { OpsHealthResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// The health plugin through the real server: the token-gated /metrics page, the admin-only health route and one full round of the watcher
// (a breach writes an event and a mail, a run of quiet rounds writes the recovery).

const { omar, nadia } = personas;
const TOKEN = 'integration-test-metrics-token-0123456789';
vi.setConfig({ testTimeout: 120_000 });

let w: RepoWorld;

const until = async <T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${w.server.logs.filter((l) => /ops-health|"level":(40|50)/.test(l)).slice(-8).join('\n')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
async function enqueueTick(): Promise<void> {
  await w.system(async (tx) => {
    const job = (await tx.query<{ id: string }>("SELECT (app.enqueue_job($1, '{}'::jsonb, now() + interval '1 hour', NULL)).id AS id", ['ops-health.tick'])).rows[0]!.id;
    await tx.query('UPDATE app.jobs SET run_at = now() WHERE id = $1', [job]);
    await tx.query("SELECT pg_notify('manythreads_jobs', $1)", ['ops-health.tick']);
  });
}
const healthEvents = () =>
  w.system(async (tx) => (await tx.query<{ payload: { check: string; state: string } }>("SELECT payload FROM app.events WHERE type = 'ops.health.changed' ORDER BY id")).rows.map((r) => r.payload));
const getMetrics = (authorization?: string) =>
  fetch(`${w.server.url}/metrics`, { headers: authorization ? { authorization } : {} }).then(async (res) => ({ status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() }));

beforeAll(async () => {
  process.env['MANYTHREADS_METRICS_TOKEN'] = TOKEN;
  process.env['MANYTHREADS_ALERT_RECOVER_ROUNDS'] = '2';
  w = await createRepoWorld();
}, 240_000);

afterAll(async () => {
  for (const name of ['MANYTHREADS_METRICS_TOKEN', 'MANYTHREADS_ALERT_RECOVER_ROUNDS', 'MANYTHREADS_ALERT_DB_CONNECTIONS_PERCENT']) delete process.env[name];
  await w?.close();
});

describe('GET /metrics', () => {
  it('is never public: no token sent is 401, a wrong token is 401', async () => {
    expect((await getMetrics()).status).toBe(401);
    expect((await getMetrics('Bearer not-the-token-not-the-token-xxxxxxxx')).status).toBe(401);
  });

  it('answers the Prometheus text format to the right token', async () => {
    const res = await getMetrics(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/^# TYPE manythreads_outbox_backlog gauge$/m);
    expect(res.text).toMatch(/^manythreads_jobs_ready \d+$/m);
    expect(res.text).toMatch(/^manythreads_run_slots_limit \d+$/m);
    expect(res.text).toMatch(/^manythreads_process_resident_memory_bytes \d+/m);
    expect(res.text).toMatch(/^manythreads_db_connections_in_use \d+$/m);
    expect(res.text).not.toContain(TOKEN);
  });
});

describe('GET /api/admin/health', () => {
  it('shows a workspace admin the numbers and the checks', async () => {
    const res = await w.call(omar, 'GET', '/api/admin/health');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = OpsHealthResponse.parse(res.body);
    expect(parsed.checks.map((c) => c.name)).toContain('outbox_lag');
  });

  it('is an admin’s: a member is refused and an anonymous caller is not signed in', async () => {
    expect((await w.call(nadia, 'GET', '/api/admin/health')).status).toBe(403);
    expect((await w.call(null, 'GET', '/api/admin/health')).status).toBe(401);
  });
});

describe('the watcher', () => {
  it('announces a breach once (an event and a mail to the admins), then the recovery after quiet rounds', async () => {
    // One percent of the connections is always exceeded by a running server.
    process.env['MANYTHREADS_ALERT_DB_CONNECTIONS_PERCENT'] = '1';
    await enqueueTick();
    await until(async () => (await healthEvents()).some((e) => e.check === 'db_connections' && e.state === 'breached'), 'the breach event');
    await until(async () => w.server.mailer.sent.some((m) => /connection/i.test(m.subject)), 'the alert mail');

    // Still breached on the next rounds: no second announcement.
    await enqueueTick();
    await enqueueTick();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await healthEvents()).filter((e) => e.check === 'db_connections' && e.state === 'breached')).toHaveLength(1);

    // The limit moved out of reach: the recovery comes after the configured quiet rounds (two), once.
    process.env['MANYTHREADS_ALERT_DB_CONNECTIONS_PERCENT'] = '100';
    await enqueueTick();
    await enqueueTick();
    await enqueueTick();
    await until(async () => (await healthEvents()).some((e) => e.check === 'db_connections' && e.state === 'recovered'), 'the recovery event');
    expect((await healthEvents()).filter((e) => e.check === 'db_connections' && e.state === 'recovered')).toHaveLength(1);
  });
});

describe('the outbox numbers', () => {
  it('leave out a row the outbox gave up on: a dead row is not backlog, and it does not make the lag grow for ever', async () => {
    const SUBSCRIBER = 'ops-health-test-dead';
    const inserted = await w.system(async (tx) =>
      (
        await tx.query(
          `INSERT INTO app.outbox (event_id, subscriber, available_at, dead_at, attempts)
           SELECT id, $1, now() - interval '2 days', now() - interval '1 day', 5 FROM app.events LIMIT 1`,
          [SUBSCRIBER],
        )
      ).rowCount,
    );
    expect(inserted, 'an event exists to point the dead row at (the watcher test above wrote one)').toBe(1);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5_500)); // the numbers are reused for 5 seconds
      const text = (await getMetrics(`Bearer ${TOKEN}`)).text;
      const lag = Number(/^manythreads_outbox_oldest_age_seconds (\S+)$/m.exec(text)?.[1]);
      expect(lag).toBeLessThan(3600);
    } finally {
      await w.system(async (tx) => void (await tx.query('DELETE FROM app.outbox WHERE subscriber = $1', [SUBSCRIBER])));
    }
  });
});
