import { randomUUID } from 'node:crypto';
import { ActorId, WorkspaceId } from '@majlis/shared';
import { createTestDatabase, dropTestDatabase, type TestDatabase } from '@majlis/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppPool, createSystemPool, enqueue, withActor, withSystem, type Actor } from '../../src/index.ts';

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;

const workspaceId = WorkspaceId.parse(randomUUID());
const person: Actor = { kind: 'person', id: ActorId.parse(randomUUID()), workspaceId };

beforeAll(async () => {
  db = await createTestDatabase();
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 4);
  await withSystem(
    async (tx) => {
      await tx.query(`INSERT INTO app.jobs (queue, payload) VALUES ('spoof', '{}')`);
      await tx.query(
        `INSERT INTO app.events (workspace_id, actor_id, type, schema_version) VALUES ($1, $2, 'kernel.test.pinged', 1)`,
        [workspaceId, person.id],
      );
      await tx.query(
        `INSERT INTO app.outbox (event_id, subscriber) SELECT id, 'spoof' FROM app.events LIMIT 1`,
      );
    },
    { pool: sysPool },
  );
}, 60_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

const asPerson = <T>(fn: (tx: Parameters<Parameters<typeof withActor<T>>[1]>[0]) => Promise<T>) =>
  withActor(person, fn, { pool: appPool });

describe('system escalation is a Postgres role, not a setting', () => {
  it('set_config(app.actor_kind, system) does not make a person the system actor', async () => {
    const r = await asPerson(async (tx) => {
      await tx.query(`SELECT set_config('app.actor_kind', 'system', true)`);
      const is = await tx.query<{ s: boolean }>('SELECT app.is_system() AS s');
      const jobs = await tx.query('SELECT 1 FROM app.jobs');
      const outbox = await tx.query('SELECT 1 FROM app.outbox');
      const links = await tx.query('SELECT 1 FROM app.entity_links');
      return { is: is.rows[0]?.s, jobs: jobs.rowCount, outbox: outbox.rowCount, links: links.rowCount };
    });
    expect(r).toEqual({ is: false, jobs: 0, outbox: 0, links: 0 });
  });

  it('writing a system-only table fails after spoofing the GUC', async () => {
    await expect(
      asPerson(async (tx) => {
        await tx.query(`SELECT set_config('app.actor_kind', 'system', true)`);
        await tx.query(`INSERT INTO app.jobs (queue) VALUES ('evil')`);
      }),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asPerson(async (tx) => {
        await tx.query(`SELECT set_config('app.actor_kind', 'system', true)`);
        await tx.query(`INSERT INTO app.outbox (event_id, subscriber) VALUES ($1, 'evil')`, [randomUUID()]);
      }),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it('majlis_app cannot SET ROLE majlis_system, nor SET SESSION AUTHORIZATION', async () => {
    await expect(asPerson((tx) => tx.query('SET ROLE majlis_system'))).rejects.toThrow(/permission denied/);
    await expect(asPerson((tx) => tx.query('SET SESSION AUTHORIZATION majlis_system'))).rejects.toThrow(
      /permission denied/,
    );
    const m = await withSystem(
      (tx) => tx.query<{ m: boolean }>(`SELECT pg_has_role('majlis_app', 'majlis_system', 'member') AS m`),
      { pool: sysPool },
    );
    expect(m.rows[0]?.m).toBe(false);
  });

  it('the app pool never is the system role, even for a system-kind actor', async () => {
    const r = await withActor({ ...person, kind: 'system' }, (tx) => tx.query('SELECT 1 FROM app.jobs'), {
      pool: appPool,
    });
    expect(r.rowCount).toBe(0);
  });

  it('withSystem still reads and writes system-only tables', async () => {
    const r = await withSystem(async (tx) => {
      const ins = await tx.query(`INSERT INTO app.jobs (queue) VALUES ('spoof2') RETURNING id`);
      const all = await tx.query('SELECT 1 FROM app.jobs');
      return { inserted: ins.rowCount, seen: all.rowCount };
    }, { pool: sysPool });
    expect(r.inserted).toBe(1);
    expect(r.seen).toBeGreaterThanOrEqual(2);
  });

  it('a person transaction can enqueue a job without becoming system', async () => {
    const out = await asPerson(async (tx) => {
      const job = await enqueue(tx, 'spoof-q', { n: 1 }, { dedupeKey: 'dk' });
      const again = await enqueue(tx, 'spoof-q', { n: 2 }, { dedupeKey: 'dk' });
      const sys = await tx.query<{ s: boolean }>('SELECT app.is_system() AS s');
      const visible = await tx.query('SELECT 1 FROM app.jobs');
      return { same: job.id === again.id, queue: job.queue, system: sys.rows[0]?.s, visible: visible.rowCount };
    });
    expect(out).toEqual({ same: true, queue: 'spoof-q', system: false, visible: 0 });
    const n = await withSystem((tx) => tx.query(`SELECT 1 FROM app.jobs WHERE queue = 'spoof-q'`), { pool: sysPool });
    expect(n.rowCount).toBe(1);
  });
});
