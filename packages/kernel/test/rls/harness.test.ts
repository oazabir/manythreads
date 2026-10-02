import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Actor } from '../../src/index.ts';
import { ActorId, WorkspaceId } from '@manythreads/shared';
import {
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findRlsViolations,
  parseRlsComment,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: TestDatabase;
let owner: pg.Client;
let appPool: pg.Pool;
let sysPool: pg.Pool;

const workspaceId = WorkspaceId.parse(randomUUID());
const person: Actor = { kind: 'person', id: ActorId.parse(randomUUID()), workspaceId };

beforeAll(async () => {
  db = await createTestDatabase();
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 4);
}, 60_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
}, 60_000);

describe('RLS harness', () => {
  it('every table in schema app off global_tables has forced RLS and a policy', async () => {
    const violations = await findRlsViolations(owner);
    expect(violations, `tables without RLS: ${violations.join(', ')}`).toEqual([]);
  });

  it('keeps the global allowlist to the known tables', async () => {
    const rows = await owner.query<{ name: string }>('SELECT name FROM app.global_tables ORDER BY name');
    expect(rows.rows.map((r) => r.name)).toEqual(['global_tables', 'plugins', 'resource_kinds', 'schema_migrations']);
  });

  it("every other table carries an 'rls: <kind>' comment (kernel tables got theirs in 0004)", async () => {
    const rows = await owner.query<{ name: string; comment: string | null }>(
      `SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND c.relname NOT IN (SELECT name FROM app.global_tables)`,
    );
    expect(rows.rows.length).toBeGreaterThan(20);
    for (const r of rows.rows) expect(parseRlsComment(r.comment), r.name).toBeDefined();
    const kinds = Object.fromEntries(rows.rows.map((r) => [r.name, parseRlsComment(r.comment)]));
    expect(kinds).toMatchObject({
      events: 'team',
      jobs: 'system',
      secrets: 'system',
      password_credentials: 'system',
      sessions: 'person',
      teams: 'team',
      team_members: 'team',
      workspaces: 'workspace',
    });
  });

  it("reports a table that has RLS but no 'rls:' comment, or an unknown kind, or a stray 'global'", async () => {
    await owner.query(`
      CREATE TABLE app.rls_uncommented (id uuid PRIMARY KEY);
      ALTER TABLE app.rls_uncommented ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.rls_uncommented FORCE ROW LEVEL SECURITY;
      CREATE POLICY p ON app.rls_uncommented USING (app.is_system());
      CREATE TABLE app.rls_bad_kind (id uuid PRIMARY KEY);
      ALTER TABLE app.rls_bad_kind ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.rls_bad_kind FORCE ROW LEVEL SECURITY;
      CREATE POLICY p ON app.rls_bad_kind USING (app.is_system());
      COMMENT ON TABLE app.rls_bad_kind IS 'rls: everyone';
      CREATE TABLE app.rls_fake_global (id uuid PRIMARY KEY);
      ALTER TABLE app.rls_fake_global ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.rls_fake_global FORCE ROW LEVEL SECURITY;
      CREATE POLICY p ON app.rls_fake_global USING (app.is_system());
      COMMENT ON TABLE app.rls_fake_global IS 'rls: global';
      CREATE TABLE app.rls_fine (id uuid PRIMARY KEY);
      ALTER TABLE app.rls_fine ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.rls_fine FORCE ROW LEVEL SECURITY;
      CREATE POLICY p ON app.rls_fine USING (app.is_system());
      COMMENT ON TABLE app.rls_fine IS 'rls: team — free text may follow the kind';
    `);
    try {
      const problems = await explainRlsViolations(owner);
      expect(problems.map((p) => p.name)).toEqual(['rls_bad_kind', 'rls_fake_global', 'rls_uncommented']);
      expect(problems.find((p) => p.name === 'rls_uncommented')?.problems).toEqual([
        expect.stringContaining("missing table comment 'rls:"),
      ]);
      expect(problems.find((p) => p.name === 'rls_fake_global')?.problems[0]).toContain('not in app.global_tables');
      expect(await findRlsViolations(owner)).toEqual(['rls_bad_kind', 'rls_fake_global', 'rls_uncommented']);
    } finally {
      await owner.query('DROP TABLE app.rls_uncommented, app.rls_bad_kind, app.rls_fake_global, app.rls_fine');
    }
  });

  it('parses the comment convention', () => {
    expect(parseRlsComment('rls: team')).toBe('team');
    expect(parseRlsComment('rls:person — own rows')).toBe('person');
    expect(parseRlsComment('RLS: team')).toBeUndefined();
    expect(parseRlsComment('rls: teams')).toBeUndefined();
    expect(parseRlsComment(null)).toBeUndefined();
    expect(parseRlsComment('GLOBAL (G): applied migration files')).toBeUndefined();
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

  it('manythreads_app and manythreads_system cannot bypass RLS', async () => {
    const r = await owner.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('manythreads_app', 'manythreads_system') ORDER BY rolname",
    );
    expect(r.rows).toEqual([
      { rolname: 'manythreads_app', rolbypassrls: false, rolsuper: false },
      { rolname: 'manythreads_system', rolbypassrls: false, rolsuper: false },
    ]);
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
      { pool: sysPool },
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
      { pool: actor.kind === 'system' ? sysPool : appPool },
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
