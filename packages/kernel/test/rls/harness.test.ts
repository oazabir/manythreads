import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Actor } from '../../src/index.ts';
import { ActorId, WorkspaceId } from '@manythreads/shared';
import {
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  findRlsViolations,
  parseRlsComment,
  channelsMigrationSource,
  teamsMigrationSource,
  testKernelMigrationSource,
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
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource] });
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

/**
 * Tables whose read plan may call a per-row policy helper, with the reason. Empty on purpose: every table that has a
 * team-visibility policy hoists it (kernel 0011). Add a table here only with a justification a reviewer can check, e.g. a
 * table bounded by headcount whose policy is genuinely per row; a stale entry fails the test below.
 */
const PER_ROW_ALLOWLIST: Record<string, string> = {};

describe('RLS cost: read policies hoist team visibility (P3-00)', () => {
  it('no table calls app.can / can_in_team / is_team_member / team_role / has_role per row in its read plan', async () => {
    const tables = (
      await owner.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname`,
      )
    ).rows.map((r) => r.name);
    expect(tables.length).toBeGreaterThan(25);
    expect(tables).toEqual(expect.arrayContaining(['teams', 'team_members', 'stub_resources', 'team_role_tags', 'events', 'scoped_kv']));
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const table of tables) {
      const calls = await findPerRowPolicyCalls(owner, table);
      if (calls.length === 0) continue;
      if (PER_ROW_ALLOWLIST[table]) used.add(table);
      else offenders.push(`${table}: ${calls.map((c) => `${c.function} in ${c.node} ${c.clause}`).join('; ')}`);
    }
    expect(offenders, `per-row policy calls (hoist them: docs/plugins/README.md, Visibility sets):\n${offenders.join('\n')}`).toEqual([]);
    expect([...used].sort(), 'allowlist entries that no longer need it').toEqual(Object.keys(PER_ROW_ALLOWLIST).sort());
  });

  it('the check catches a per-row policy and accepts the hoisted form of the same rule', async () => {
    await owner.query(`
      CREATE TABLE app.rls_perrow_probe (id uuid PRIMARY KEY DEFAULT uuidv7(), team_id uuid NOT NULL);
      ALTER TABLE app.rls_perrow_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.rls_perrow_probe FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON app.rls_perrow_probe TO manythreads_app;
      CREATE POLICY slow ON app.rls_perrow_probe FOR SELECT USING (app.is_system() OR app.can_in_team(team_id, 'read'));
      CREATE TABLE app.rls_hoisted_probe (id uuid PRIMARY KEY DEFAULT uuidv7(), team_id uuid NOT NULL);
      ALTER TABLE app.rls_hoisted_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.rls_hoisted_probe FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON app.rls_hoisted_probe TO manythreads_app;
      CREATE POLICY fast ON app.rls_hoisted_probe FOR SELECT
        USING (app.is_system() OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[]));
    `);
    try {
      const slow = await findPerRowPolicyCalls(owner, 'rls_perrow_probe');
      expect(slow.map((c) => c.function)).toEqual(['app.can_in_team']);
      expect(slow[0]).toMatchObject({ table: 'rls_perrow_probe', clause: 'Filter' });
      expect(await findPerRowPolicyCalls(owner, 'rls_hoisted_probe')).toEqual([]);
    } finally {
      await owner.query('DROP TABLE app.rls_perrow_probe, app.rls_hoisted_probe');
    }
  });

  it('a table the app role cannot read has no plan to check', async () => {
    expect(await findPerRowPolicyCalls(owner, 'secrets')).toEqual([]);
  });

  it('rejects anything but a plain table name', async () => {
    await expect(findPerRowPolicyCalls(owner, 'teams; DROP TABLE app.teams')).rejects.toThrow(/Unsafe table name/);
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
