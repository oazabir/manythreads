import { randomUUID } from 'node:crypto';
import { createAppPool, withActor, withSystem, type Actor } from '../../src/index.ts';
import { ActorId, WorkspaceId } from '@majlis/shared';
import {
  createTestDatabase,
  dropTestDatabase,
  findRlsViolations,
  type TestDatabase,
} from '@majlis/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: TestDatabase;
let owner: pg.Client;
let appPool: pg.Pool;

const workspaceId = WorkspaceId.parse(randomUUID());
const person: Actor = { kind: 'person', id: ActorId.parse(randomUUID()), workspaceId };

beforeAll(async () => {
  db = await createTestDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  appPool = createAppPool(db.appUrl, 4);
}, 60_000);

afterAll(async () => {
  await appPool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

describe('RLS harness', () => {
  it('every table in schema app off global_tables has forced RLS and a policy', async () => {
    const violations = await findRlsViolations(owner);
    expect(violations, `tables without RLS: ${violations.join(', ')}`).toEqual([]);
  });

  it('keeps the global allowlist to the three known tables', async () => {
    const rows = await owner.query<{ name: string }>('SELECT name FROM app.global_tables ORDER BY name');
    expect(rows.rows.map((r) => r.name)).toEqual(['global_tables', 'plugins', 'schema_migrations']);
  });

  it('names a table that has no RLS', async () => {
    await owner.query('CREATE TABLE app.rls_less_probe (id uuid PRIMARY KEY DEFAULT uuidv7())');
    try {
      expect(await findRlsViolations(owner)).toEqual(['rls_less_probe']);
    } finally {
      await owner.query('DROP TABLE app.rls_less_probe');
    }
  });

  it('names tables with RLS enabled but not forced, or forced without a policy', async () => {
    await owner.query(`
      CREATE TABLE app.rls_not_forced (id uuid PRIMARY KEY);
      ALTER TABLE app.rls_not_forced ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON app.rls_not_forced USING (true);
      CREATE TABLE app.rls_no_policy (id uuid PRIMARY KEY);
      ALTER TABLE app.rls_no_policy ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.rls_no_policy FORCE ROW LEVEL SECURITY;
    `);
    try {
      expect(await findRlsViolations(owner)).toEqual(['rls_no_policy', 'rls_not_forced']);
    } finally {
      await owner.query('DROP TABLE app.rls_not_forced, app.rls_no_policy');
    }
  });

  it('majlis_app cannot bypass RLS', async () => {
    const r = await owner.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'majlis_app'",
    );
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

describe('cross-team isolation', () => {
  const teamA = randomUUID();
  const teamB = randomUUID();

  const insertLink = (teamId: string) =>
    withSystem(
      (tx) =>
        tx.query(
          `INSERT INTO entity_links (team_id, src_type, src_id, dst_type, dst_id, kind)
           VALUES ($1, 'message', $2, 'task', $3, 'relates')`,
          [teamId, randomUUID(), randomUUID()],
        ),
      { pool: appPool },
    );

  beforeAll(async () => {
    await insertLink(teamA);
    await insertLink(teamB);
  }, 30_000);

  const count = (actor: Actor, where: string, values: unknown[] = []) =>
    withActor(
      actor,
      async (tx) => {
        const r = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM entity_links ${where}`, values);
        return Number(r.rows[0]?.n);
      },
      { pool: appPool },
    );

  it('the system actor sees both teams', async () => {
    const system: Actor = { kind: 'system', id: ActorId.parse(randomUUID()), workspaceId };
    expect(await count(system, 'WHERE team_id = $1', [teamA])).toBe(1);
    expect(await count(system, 'WHERE team_id = $1', [teamB])).toBe(1);
  });

  // Phase 2 adds membership; until then a non-system actor belongs to no team, so it sees nothing.
  it('a non-system actor reads zero rows of team B (and of team A)', async () => {
    expect(await count(person, 'WHERE team_id = $1', [teamB])).toBe(0);
    expect(await count(person, 'WHERE team_id = $1', [teamA])).toBe(0);
    expect(await count(person, '')).toBe(0);
  });

  it('a non-system actor cannot write a team row either', async () => {
    await expect(
      withActor(
        person,
        (tx) =>
          tx.query(
            `INSERT INTO entity_links (team_id, src_type, src_id, dst_type, dst_id, kind)
             VALUES ($1, 'a', $2, 'b', $3, 'k')`,
            [teamB, randomUUID(), randomUUID()],
          ),
        { pool: appPool },
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('outside withActor (no actor set) nothing is visible', async () => {
    const client = await appPool.connect();
    try {
      const r = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM app.entity_links');
      expect(r.rows[0]?.n).toBe('0');
    } finally {
      client.release();
    }
  });
});
