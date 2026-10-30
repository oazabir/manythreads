import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  guardrailsDlpMigrationSource,
  personaActor,
  personas,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P10-04: who may read and write the data-loss policy tables. Every member of the workspace reads them (the check runs in the sender's transaction);
// only workspace owners and admins write; another workspace sees none of it.

const { omar, nadia, tariq } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let other: { ws: string; actor: string };

const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const count = (p: Persona, table: string): Promise<number> => as(p, async (tx) => Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0]!.n));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, guardrailsDlpMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  other = await withSystem(
    async (tx) => {
      const ws = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('other', 'Other') RETURNING id`)).rows[0]!.id;
      const person = (await tx.query<{ id: string }>(`INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, 'Xavi', 'x@other.example') RETURNING id`, [ws])).rows[0]!.id;
      const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [ws, person])).rows[0]!.id;
      await tx.query(`INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [ws, person]);
      await tx.query(`INSERT INTO app.dlp_detectors (workspace_id, detector, action) VALUES ($1, 'api-key', 'block')`, [ws]);
      await tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, 'theirs', 'XYZ[0-9]')`, [ws]);
      return { ws, actor };
    },
    { pool: sysPool },
  );
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('dlp_detectors and dlp_custom_rules (P10-04)', () => {
  it('pass the RLS harness and read without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'dlp_detectors')).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'dlp_custom_rules')).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('are written by a workspace admin and read by every member of that workspace', async () => {
    await as(omar, async (tx) => {
      await tx.query(`INSERT INTO app.dlp_detectors (workspace_id, detector, action, updated_by) VALUES ($1, 'api-key', 'block', $2)`, [omar.workspaceId, omar.actorId]);
      await tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern, updated_by) VALUES ($1, 'mine', 'ABC[0-9]', $2)`, [omar.workspaceId, omar.actorId]);
    });
    for (const p of [omar, nadia, tariq]) {
      expect(await count(p, 'dlp_detectors'), p.key).toBe(1);
      expect(await count(p, 'dlp_custom_rules'), p.key).toBe(1);
    }
  });

  it('are not changed by a member or a team lead who is not an admin', async () => {
    for (const p of [nadia, tariq]) {
      expect(await code(as(p, (tx) => tx.query(`INSERT INTO app.dlp_detectors (workspace_id, detector, action) VALUES ($1, 'card-number', 'block')`, [p.workspaceId])))).toBe('42501');
      expect(await code(as(p, (tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, 'sneaky', 'a')`, [p.workspaceId])))).toBe('42501');
      // an update or delete of rows a member can see changes nothing
      const changed = await as(p, async (tx) => {
        const u = await tx.query(`UPDATE app.dlp_detectors SET action = 'allow'`);
        const d = await tx.query(`DELETE FROM app.dlp_custom_rules`);
        return [u.rowCount, d.rowCount];
      });
      expect(changed, p.key).toEqual([0, 0]);
    }
    expect(await count(omar, 'dlp_detectors')).toBe(1);
    expect(await count(omar, 'dlp_custom_rules')).toBe(1);
  });

  it('keep each workspace to its own rows', async () => {
    const theirs = await withActor({ kind: 'person', id: other.actor as never, workspaceId: other.ws as never }, async (tx) => (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.dlp_custom_rules')).rows, { pool: appPool });
    expect(theirs.map((r) => r.workspace_id)).toEqual([other.ws]);
    // an admin cannot write a row into another workspace
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, 'cross', 'a')`, [other.ws])))).toBe('42501');
  });

  it('refuse values outside the allowed ones', async () => {
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.dlp_detectors (workspace_id, detector, action) VALUES ($1, 'iban', 'shout')`, [omar.workspaceId])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern, action) VALUES ($1, 'x1', 'a', 'allow')`, [omar.workspaceId])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, 'Bad Name', 'a')`, [omar.workspaceId])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, 'long', $2)`, [omar.workspaceId, 'a'.repeat(191)])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, 'mine', 'dup')`, [omar.workspaceId])))).toBe('23505');
  });
  it('stop at 20 rules a workspace, whichever door writes, also when two inserts arrive at once', async () => {
    // the workspace has 1 rule from the tests above; fill it to 19, then race two more for the last place
    await as(omar, async (tx) => {
      await tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) SELECT $1, 'fill-' || i, 'F' || i FROM generate_series(1, 18) i`, [omar.workspaceId]);
    });
    expect(await count(omar, 'dlp_custom_rules')).toBe(19);
    const attempts = await Promise.all(['race-a', 'race-b'].map((name) => code(as(omar, (tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, $2, 'R')`, [omar.workspaceId, name])))));
    expect(attempts.filter((c) => c === undefined)).toHaveLength(1);
    expect(attempts.filter((c) => c === '23514')).toHaveLength(1);
    expect(await count(omar, 'dlp_custom_rules')).toBe(20);
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, 'one-more', 'M')`, [omar.workspaceId])))).toBe('23514');
    // another workspace is counted on its own, and a change to an existing rule is not an insert
    expect(await code(withSystem((tx) => tx.query(`INSERT INTO app.dlp_custom_rules (workspace_id, name, pattern) VALUES ($1, 'theirs-2', 'T')`, [other.ws]), { pool: sysPool }))).toBeUndefined();
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.dlp_custom_rules SET pattern = 'Z' WHERE name = 'mine'`)))).toBeUndefined();
  });
});
