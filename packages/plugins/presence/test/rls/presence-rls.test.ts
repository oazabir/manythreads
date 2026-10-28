import { fileURLToPath } from 'node:url';
import { createAppPool, createSystemPool, withActor, withSystem, type MigrationSource, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
  testClient,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, lena } = personas;

const presenceMigrationSource: MigrationSource = {
  namespace: 'presence',
  dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
};

// Who reads and writes what (pnpm test:rls): status, time zone and the out-of-office note are readable by the workspace's members and by a
// guest only for themself; Do not disturb is readable by its person alone. A person writes only their own rows.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const putStatus = (p: Persona, who: Persona = p, text = 'hello'): Promise<unknown> =>
  as(p, (tx) =>
    tx.query(
      `INSERT INTO app.person_status (person_id, workspace_id, status_text) VALUES ($1, $2, $3)
       ON CONFLICT (person_id) DO UPDATE SET status_text = EXCLUDED.status_text`,
      [who.personId, who.workspaceId, text],
    ),
  );
const putDnd = (p: Persona, who: Persona = p): Promise<unknown> =>
  as(p, (tx) =>
    tx.query(
      `INSERT INTO app.dnd_settings (person_id, workspace_id, enabled) VALUES ($1, $2, true)
       ON CONFLICT (person_id) DO UPDATE SET enabled = true`,
      [who.personId, who.workspaceId],
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, presenceMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the presence tables pass the RLS harness', () => {
  it('RLS is enabled and forced, with a policy and an rls comment; no policy calls a per-row helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['person_status', 'dnd_settings']) {
        expect(await findPerRowPolicyCalls(admin, table), `${table} calls a helper per row`).toEqual([]);
        const plan = await admin.query('SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass', [`app.${table}`]);
        expect(plan.rows[0], table).toEqual({ on: true, forced: true });
      }
    } finally {
      await admin.end();
    }
  });
});

describe('person_status: members read the workspace, a guest only themself, and a person writes only their own row', () => {
  it('a person writes their own row and nobody else\'s', async () => {
    expect(await putStatus(nadia)).toBeDefined();
    expect(await putStatus(rafi)).toBeDefined();
    expect(await putStatus(lena)).toBeDefined();
    expect(await code(putStatus(nadia, rafi))).toBe('42501');                          // insert for someone else
    expect(await code(as(nadia, (tx) => tx.query("INSERT INTO app.person_status (person_id, workspace_id) VALUES ($1, '00000000-0000-7000-8000-00000000ffff')", [nadia.personId])))).toBeDefined();
    expect((await as(nadia, (tx) => tx.query("UPDATE app.person_status SET status_text = 'hijacked' WHERE person_id = $1", [rafi.personId]))).rowCount).toBe(0);
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.person_status WHERE person_id = $1', [rafi.personId]))).rowCount).toBe(0);
    expect((await q<{ status_text: string }>(rafi, 'SELECT status_text FROM app.person_status WHERE person_id = $1', [rafi.personId]))[0]?.status_text).toBe('hello');
  });

  it('a person cannot move their own row to another person (the check on update)', async () => {
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.person_status SET person_id = $1 WHERE person_id = $2', [rafi.personId, nadia.personId])))).toBeDefined();
  });

  it('members read everyone of the workspace; a guest reads only themself and sees nobody else\'s status', async () => {
    const all = [nadia.personId, rafi.personId, lena.personId].sort();
    expect((await q<{ person_id: string }>(omar, 'SELECT person_id FROM app.person_status')).map((r) => r.person_id).sort()).toEqual(all);
    expect((await q<{ person_id: string }>(rafi, 'SELECT person_id FROM app.person_status')).map((r) => r.person_id).sort()).toEqual(all);
    expect((await q<{ person_id: string }>(lena, 'SELECT person_id FROM app.person_status')).map((r) => r.person_id)).toEqual([lena.personId]);
    expect(await q(lena, 'SELECT 1 FROM app.person_status WHERE person_id = $1', [nadia.personId])).toEqual([]);
  });

  it('the out-of-office delegate check answers yes only for an active person of the caller\'s workspace', async () => {
    const check = async (p: Persona, id: string): Promise<boolean> => (await q<{ ok: boolean }>(p, 'SELECT app.presence_person_in_workspace($1) AS ok', [id]))[0]!.ok;
    expect(await check(lena, nadia.personId)).toBe(true);        // a guest cannot list people, but may name a delegate
    expect(await check(nadia, '00000000-0000-7000-8000-00000000ffff')).toBe(false);
  });
});

describe('dnd_settings: private to the person', () => {
  it('a person writes and reads only their own settings; nobody else, an admin included', async () => {
    expect(await putDnd(nadia)).toBeDefined();
    expect(await putDnd(rafi)).toBeDefined();
    expect(await code(putDnd(nadia, rafi))).toBe('42501');
    expect((await as(nadia, (tx) => tx.query('UPDATE app.dnd_settings SET enabled = false WHERE person_id = $1', [rafi.personId]))).rowCount).toBe(0);
    expect((await q<{ person_id: string }>(nadia, 'SELECT person_id FROM app.dnd_settings')).map((r) => r.person_id)).toEqual([nadia.personId]);
    expect(await q(omar, 'SELECT person_id FROM app.dnd_settings')).toEqual([]);
    expect(await q(lena, 'SELECT person_id FROM app.dnd_settings')).toEqual([]);
  });

  it('the system reads every row (it holds and releases notifications by them)', async () => {
    expect((await sys((tx) => tx.query('SELECT person_id FROM app.dnd_settings'))).rows).toHaveLength(2);
  });

  it('the schedule must be an object', async () => {
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.dnd_settings SET schedule = '[]'::jsonb WHERE person_id = $1", [nadia.personId])))).toBe('23514');
  });
});
