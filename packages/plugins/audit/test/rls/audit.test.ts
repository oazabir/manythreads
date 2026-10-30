import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  auditMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P10-05: who may read the audit rows (workspace owners and admins of that workspace, nobody else), and that nobody but the system role writes them and
// not even it edits or removes one.

const { omar, nadia, tariq } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let otherWorkspace: string;
let otherOwner: { actor: string };

const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const insertRow = (tx: Tx, workspaceId: string, id: string = randomUUID()): Promise<unknown> =>
  tx.query(
    `INSERT INTO app.audit_events (id, workspace_id, occurred_at, actor_kind, actor_name, category, action, outcome, source)
     VALUES ($1, $2, now(), 'system', 'System', 'system', 'retention.sweep_completed', 'ok', 'event') ON CONFLICT (id) DO NOTHING`,
    [id, workspaceId],
  );
const count = (p: Persona): Promise<number> => as(p, async (tx) => Number((await tx.query<{ n: string }>('SELECT count(*)::int AS n FROM app.audit_events')).rows[0]!.n));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, auditMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  const ids = await withSystem(
    async (tx) => {
      const ws = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('other', 'Other') RETURNING id`)).rows[0]!.id;
      const person = (await tx.query<{ id: string }>(`INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, 'Xavi', 'x@other.example') RETURNING id`, [ws])).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [ws, person])).rows[0]!.id;
      await tx.query(`INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [ws, person]);
      return { ws, actor };
    },
    { pool: sysPool },
  );
  otherWorkspace = ids.ws;
  otherOwner = ids;
  await sys(async (tx) => {
    for (let i = 0; i < 3; i += 1) await insertRow(tx, omar.workspaceId);
  });
  await withSystem(async (tx) => void (await insertRow(tx, otherWorkspace)), { pool: sysPool, workspaceId: otherWorkspace as never });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('audit_events (P10-05)', () => {
  it('passes the RLS harness and reads without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'audit_events')).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('is read by a workspace admin of that workspace and by nobody else', async () => {
    expect(await count(omar)).toBe(3);
    expect(await count(nadia)).toBe(0); // a member
    expect(await count(tariq)).toBe(0); // a team lead is not a workspace admin
    const other = await withActor({ kind: 'person', id: otherOwner.actor as never, workspaceId: otherWorkspace as never }, async (tx) => (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.audit_events')).rows, { pool: appPool });
    expect(other.map((r) => r.workspace_id)).toEqual([otherWorkspace]); // its own row only, none of Kahf's
  });

  it('is written only by the system role, and the system role cannot edit or remove a row', async () => {
    expect(await code(as(omar, (tx) => insertRow(tx, omar.workspaceId)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.audit_events SET outcome = 'ok'`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.audit_events')))).toBe('42501');
    expect(await code(sys((tx) => tx.query(`UPDATE app.audit_events SET outcome = 'denied'`)))).toBe('42501');
    expect(await code(sys((tx) => tx.query('DELETE FROM app.audit_events')))).toBe('42501');
    expect(await code(sys((tx) => tx.query('TRUNCATE app.audit_events')))).toBe('42501');
  });

  it('writes one source once', async () => {
    const id = randomUUID();
    await sys(async (tx) => {
      await insertRow(tx, omar.workspaceId, id);
      await insertRow(tx, omar.workspaceId, id);
    });
    expect(await count(omar)).toBe(4);
  });

  it('refuses a value outside the enums', async () => {
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.audit_events (id, workspace_id, occurred_at, actor_kind, actor_name, category, action, outcome, source) VALUES ($1, $2, now(), 'system', 'S', 'system', 'x.y', 'maybe', 'event')`, [randomUUID(), omar.workspaceId])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.audit_events (id, workspace_id, occurred_at, actor_kind, actor_name, category, action, outcome, source) VALUES ($1, $2, now(), 'system', 'S', 'system', 'Not An Action', 'ok', 'event')`, [randomUUID(), omar.workspaceId])))).toBe('23514');
  });

  it('keeps the sweep position and the signing keys away from the app role', async () => {
    expect(await code(as(omar, (tx) => tx.query('SELECT * FROM app.audit_progress')))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT * FROM app.audit_signing_keys')))).toBe('42501');
  });
});
