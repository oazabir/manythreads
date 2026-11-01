import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  importMigrationSource,
  personaActor,
  personas,
  remindersMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  webhooksMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi } = personas;

// Who reads and writes what (pnpm test:rls). Import runs and the stand-ins for people are for workspace owners and admins; a member sees nothing. The
// request role may start a run and ask for a change of its state, never write a report or touch a stand-in; the map of what became what is the job's alone.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let runId = '';
let placeholderActor = '';
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const SHA = 'a'.repeat(64);
const insertRun = (p: Persona, createdBy: Persona = p) =>
  as(p, (tx) =>
    tx.query<{ id: string }>(
      `INSERT INTO app.import_runs (workspace_id, source, team_id, file_name, size_bytes, sha256, blob_key, created_by)
       VALUES ($1, 'slack', $2, 'export.zip', 10, $3, 'blob-1', $4) RETURNING id`,
      [omar.workspaceId, TEAM_IDS.Engineering, SHA, createdBy.actorId],
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, webhooksMigrationSource, remindersMigrationSource, importMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  runId = (
    await sys(async (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO app.import_runs (workspace_id, source, team_id, file_name, size_bytes, sha256, created_by) VALUES ($1, 'slack', $2, 'a.zip', 1, $3, $4) RETURNING id`,
        [omar.workspaceId, TEAM_IDS.Engineering, SHA, omar.actorId],
      ),
    )
  ).rows[0]!.id;
  placeholderActor = await sys(async (tx) => {
    const ref = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
    const actor = (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('system', $1, $2) RETURNING id", [omar.workspaceId, ref])).rows[0]!.id;
    await tx.query("INSERT INTO app.import_people (id, workspace_id, source, source_id, name, email, actor_id) VALUES ($1, $2, 'slack', 'U9', 'Jon', 'jon@example.test', $3)", [ref, omar.workspaceId, actor]);
    await tx.query("INSERT INTO app.import_map (workspace_id, source, kind, source_id, target_id) VALUES ($1, 'slack', 'message', 'C1:1', $2)", [omar.workspaceId, actor]);
    return actor;
  });
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the import tables pass the RLS harness', () => {
  it('RLS is enabled and forced on all three tables, with policies and an rls comment; no policy calls a per-row helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['import_runs', 'import_people', 'import_map']) {
        expect(await findPerRowPolicyCalls(admin, table), table).toEqual([]);
        const plan = await admin.query('SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass', [`app.${table}`]);
        expect(plan.rows[0], table).toEqual({ on: true, forced: true });
      }
    } finally {
      await admin.end();
    }
  });
});

describe('runs', () => {
  it('a workspace admin sees them and a member sees none', async () => {
    expect((await q(omar, 'SELECT id FROM app.import_runs')).map((r) => r['id'])).toEqual([runId]);
    expect(await q(nadia, 'SELECT id FROM app.import_runs')).toEqual([]);
    expect(await q(rafi, 'SELECT id FROM app.import_runs WHERE id = $1', [runId])).toEqual([]);
  });

  it('an admin starts a run in their own name; a member cannot; nobody can write another person\'s name on it', async () => {
    expect((await insertRun(omar)).rows).toHaveLength(1);
    expect(await code(insertRun(nadia))).toBe('42501');
    expect(await code(insertRun(omar, nadia))).toBe('42501');
  });

  it('the request role can change a run\'s state but never write its reports or its archive checksum', async () => {
    expect((await as(omar, (tx) => tx.query('UPDATE app.import_runs SET cancel_requested = true, updated_at = now() WHERE id = $1 RETURNING id', [runId]))).rows).toHaveLength(1);
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.import_runs SET report = '{}'::jsonb WHERE id = $1`, [runId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('UPDATE app.import_runs SET sha256 = $2 WHERE id = $1', [runId, 'b'.repeat(64)])))).toBe('42501');
    expect((await as(nadia, (tx) => tx.query('UPDATE app.import_runs SET cancel_requested = false WHERE id = $1 RETURNING id', [runId]))).rows).toHaveLength(0);
  });

  it('only an admin deletes one', async () => {
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.import_runs WHERE id = $1 RETURNING id', [runId]))).rows).toHaveLength(0);
    const mine = (await insertRun(omar)).rows[0]!.id;
    expect((await as(omar, (tx) => tx.query('DELETE FROM app.import_runs WHERE id = $1 RETURNING id', [mine]))).rows).toHaveLength(1);
  });
});

describe('stand-ins and the map', () => {
  it('an admin reads the stand-ins; a member does not; nobody but the job writes them', async () => {
    expect(await q(omar, 'SELECT actor_id FROM app.import_people')).toEqual([{ actor_id: placeholderActor }]);
    expect(await q(nadia, 'SELECT actor_id FROM app.import_people')).toEqual([]);
    expect(await code(as(omar, (tx) => tx.query('UPDATE app.import_people SET claimed_at = now()')))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.import_people')))).toBe('42501');
  });

  it('the map is the job\'s alone: not even an admin reads it', async () => {
    expect(await code(q(omar, 'SELECT * FROM app.import_map'))).toBe('42501');
    expect((await sys((tx) => tx.query('SELECT 1 FROM app.import_map'))).rows).toHaveLength(1);
  });

  it('acting as an imported author is for the job: the request role may not call it', async () => {
    expect(await code(as(omar, (tx) => tx.query('SELECT app.import_act_as($1)', [placeholderActor])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT app.import_claim_for_person($1)', [omar.personId])))).toBe('42501');
    expect((await sys((tx) => tx.query('SELECT app.import_act_as($1)', [placeholderActor]))).rows).toHaveLength(1);
  });

  it('the job cannot act as an actor that is not a person or one of its own stand-ins', async () => {
    const other = await sys(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('system', $1, uuidv7()) RETURNING id", [omar.workspaceId])).rows[0]!.id);
    expect(await code(sys((tx) => tx.query('SELECT app.import_act_as($1)', [other])))).toBe('P0002');
    expect(await code(sys((tx) => tx.query('SELECT app.import_act_as(uuidv7())')))).toBe('P0002');
  });
});
