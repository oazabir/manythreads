import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_APP_PASSWORD,
  DEFAULT_SYSTEM_PASSWORD,
  kernelMigrationSource,
  runMigrations,
  type MigrationSource,
} from '@manythreads/kernel';
import pg from 'pg';

/** Migrations of the test-only plugin test-kernel (holds `stub_resources`); pass it in `sources` next to the kernel's. */
export const testKernelMigrationSource: MigrationSource = {
  namespace: 'test-kernel',
  dir: fileURLToPath(new URL('../../plugins/test-kernel/migrations/', import.meta.url)),
};

/** Migrations of the teams plugin (holds `team_role_tags`); pass it in `sources` when a test needs those tables. */
export const teamsMigrationSource: MigrationSource = {
  namespace: 'teams',
  dir: fileURLToPath(new URL('../../plugins/teams/migrations/', import.meta.url)),
};

/** Migrations of the channels plugin (channels, messages, threads); pass it in `sources` after `teamsMigrationSource`. */
export const channelsMigrationSource: MigrationSource = {
  namespace: 'channels',
  dir: fileURLToPath(new URL('../../plugins/channels/migrations/', import.meta.url)),
};

/** Migrations of the direct-messages plugin (`app.dms_get_or_create`); pass it in `sources` after `channelsMigrationSource`. */
export const directMessagesMigrationSource: MigrationSource = {
  namespace: 'direct-messages',
  dir: fileURLToPath(new URL('../../plugins/direct-messages/migrations/', import.meta.url)),
};

export const DEV_TEST_DATABASE_URL = 'postgresql://manythreads_owner:manythreads@localhost:55432/manythreads';

/** Owner connection string of the cluster's admin database; tests create and drop temp databases through it. */
export function testAdminUrl(): string {
  return process.env['MANYTHREADS_TEST_DATABASE_URL'] ?? DEV_TEST_DATABASE_URL;
}

export interface TestDatabase {
  name: string;
  /** Owner (manythreads_owner) connection string to the temp database. */
  ownerUrl: string;
  /** manythreads_app connection string to the temp database. */
  appUrl: string;
  /** manythreads_system connection string to the temp database (the only login for which app.is_system() is true). */
  systemUrl: string;
  /** Files applied by the initial migrate (0 when `migrate: false`). */
  applied: number;
}

export interface CreateTestDatabaseOptions {
  /** Run the kernel (and `sources`) migrations. Default true. */
  migrate?: boolean;
  /** Extra migration sources (plugins) applied after the kernel directory. */
  sources?: readonly MigrationSource[];
}

/** Same server, different database, optionally a different login. */
export function withDatabase(url: string, database: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/** Roles are cluster-wide, so concurrent test files must not create/alter them at the same moment. */
const CLUSTER_LOCK_KEY = 7_450_002;

/** Runs `fn` while holding a lock shared by every test process on the cluster (advisory locks are per database). */
export async function withClusterLock<T>(fn: () => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [CLUSTER_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [CLUSTER_LOCK_KEY]);
    }
  } finally {
    await admin.end();
  }
}

/** Runs migrations on a test database under the cluster lock (the runner's own lock is per database). */
export function migrateTestDatabase(
  db: Pick<TestDatabase, 'ownerUrl'>,
  sources: readonly MigrationSource[] = [kernelMigrationSource],
  appPassword: string | null = DEFAULT_APP_PASSWORD,
  systemPassword: string | null = DEFAULT_SYSTEM_PASSWORD,
): Promise<number> {
  return withClusterLock(() => runMigrations({ connectionString: db.ownerUrl, sources, appPassword, systemPassword }));
}

/** Creates a fresh `manythreads_test_*` database and (by default) migrates it. Drop it with dropTestDatabase. */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = testAdminUrl();
  const name = `manythreads_test_${randomBytes(6).toString('hex')}`;
  const ownerUrl = withDatabase(adminUrl, name);
  const appUrl = withDatabase(adminUrl, name, { name: 'manythreads_app', password: DEFAULT_APP_PASSWORD });
  const systemUrl = withDatabase(adminUrl, name, { name: 'manythreads_system', password: DEFAULT_SYSTEM_PASSWORD });
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const db: TestDatabase = { name, ownerUrl, appUrl, systemUrl, applied: 0 };
  if (options.migrate !== false) {
    db.applied = await migrateTestDatabase(db, [kernelMigrationSource, ...(options.sources ?? [])]);
  }
  return db;
}

/** Drops the temp database, terminating any connection still open to it. */
export async function dropTestDatabase(db: TestDatabase): Promise<void> {
  if (!/^manythreads_test_[0-9a-f]+$/.test(db.name)) throw new Error(`Refusing to drop ${db.name}`);
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${db.name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Valid kinds in a `COMMENT ON TABLE x IS 'rls: <kind>'` (PLAN.md P2-00; global tables are exempt from the comment). */
export const RLS_KINDS = ['team', 'person', 'workspace', 'system', 'global'] as const;
export type RlsKind = (typeof RLS_KINDS)[number];

const RLS_COMMENT = /^rls:\s*(team|person|workspace|system|global)\b/;

/** The kind named by a table comment, or undefined when it has none (or an unknown one). */
export function parseRlsComment(comment: string | null | undefined): RlsKind | undefined {
  const kind = comment ? RLS_COMMENT.exec(comment)?.[1] : undefined;
  return kind as RlsKind | undefined;
}

export interface RlsProblem {
  name: string;
  problems: string[];
}

interface Queryable {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Tables in schema `app` that break the RLS rule (PLAN.md D3, P1-04, P2-00), with the reasons: not on the
 * `global_tables` allowlist and missing ENABLE, FORCE, a policy, or a valid `rls: <kind>` table comment; or tagged
 * `rls: global` without being on the allowlist. Run it as the owner.
 */
export async function explainRlsViolations(client: Queryable): Promise<RlsProblem[]> {
  const result = await client.query(`
    SELECT c.relname AS name,
           c.relrowsecurity AS enabled,
           c.relforcerowsecurity AS forced,
           EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) AS has_policy,
           obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND c.relname NOT IN (SELECT name FROM app.global_tables)
    ORDER BY c.relname
  `);
  const out: RlsProblem[] = [];
  for (const row of result.rows) {
    const problems: string[] = [];
    if (!row['enabled']) problems.push('row level security is not enabled');
    if (!row['forced']) problems.push('row level security is not forced');
    if (!row['has_policy']) problems.push('no policy');
    const kind = parseRlsComment(row['comment'] as string | null);
    if (!kind) problems.push("missing table comment 'rls: team|person|workspace|system|global'");
    else if (kind === 'global') problems.push("tagged 'rls: global' but not in app.global_tables");
    if (problems.length > 0) out.push({ name: String(row['name']), problems });
  }
  return out;
}

/** Names of the tables explainRlsViolations reports. */
export async function findRlsViolations(client: Queryable): Promise<string[]> {
  return (await explainRlsViolations(client)).map((p) => p.name);
}

/**
 * Policy helpers that answer "may the caller see this team / resource?" for ONE row. In a read policy they run once per row
 * (70 to 250 microseconds each, so an unscoped count over 300,000 rows took 77 s); the policy must instead probe a set
 * computed once per statement: `team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])` (kernel 0011, which also
 * documents the idiom). Names are matched schema-qualified in the plan.
 */
export const PER_ROW_POLICY_FUNCTIONS = ['can', 'can_in_team', 'is_team_member', 'team_role', 'has_role'] as const;

/** A per-row call the planner left in a scan, join or index condition of a table's read plan. */
export interface PerRowPolicyCall {
  table: string;
  /** Plan node type, e.g. `Seq Scan`. */
  node: string;
  /** Which condition: `Filter`, `Index Cond`, ... */
  clause: string;
  /** The offending function, e.g. `app.can_in_team`. */
  function: string;
  /** The full condition text from EXPLAIN. */
  condition: string;
}

interface PlanNode {
  'Node Type'?: string;
  'Parent Relationship'?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

const PLAN_CONDITIONS = ['Filter', 'Index Cond', 'Join Filter', 'Recheck Cond', 'One-Time Filter', 'Hash Cond', 'Merge Cond', 'TID Cond'];
const PER_ROW_CALL = new RegExp(`\\bapp\\.(${PER_ROW_POLICY_FUNCTIONS.join('|')})\\s*\\(`);

function collectPerRowCalls(node: PlanNode, table: string, out: PerRowPolicyCall[]): void {
  // An InitPlan runs once per statement, so a call inside it is exactly what the idiom wants.
  if (node['Parent Relationship'] === 'InitPlan') return;
  for (const clause of PLAN_CONDITIONS) {
    const condition = node[clause];
    if (typeof condition !== 'string') continue;
    const hit = PER_ROW_CALL.exec(condition);
    if (hit) out.push({ table, node: String(node['Node Type'] ?? '?'), clause, function: `app.${hit[1]}`, condition });
  }
  for (const child of node.Plans ?? []) collectPerRowCalls(child, table, out);
}

/**
 * EXPLAIN (VERBOSE) of `SELECT count(*) FROM app.<table>` as the non-system role manythreads_app (the plan carries the
 * table's row-level-security conditions) and every per-row call of app.can / can_in_team / is_team_member / team_role /
 * has_role left outside an InitPlan. Empty means the read policy hoists its team visibility. Tables manythreads_app cannot
 * read at all (system-only) have no plan to check and give []. Runs in a rolled-back transaction, so `client` may be the
 * owner connection (a superuser may SET ROLE; the plan does not depend on who the actor is).
 */
export async function findPerRowPolicyCalls(
  client: { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  table: string,
): Promise<PerRowPolicyCall[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Unsafe table name "${table}"`);
  const readable = await client.query(`SELECT has_table_privilege('manythreads_app', 'app.${table}', 'SELECT') AS ok`);
  if (readable.rows[0]?.['ok'] !== true) return [];
  const out: PerRowPolicyCall[] = [];
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE manythreads_app');
    await client.query('SET LOCAL search_path = pg_catalog'); // EXPLAIN qualifies function names that are not on the path
    const res = await client.query(`EXPLAIN (VERBOSE, FORMAT JSON) SELECT count(*) FROM app.${table}`);
    const raw = res.rows[0]?.['QUERY PLAN'];
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
    const root = parsed[0]?.Plan;
    if (root) collectPerRowCalls(root, table, out);
  } finally {
    await client.query('ROLLBACK');
  }
  return out;
}

/** One query as the database owner (bypasses RLS): for specs that arrange or inspect state the API cannot reach. */
export async function ownerSql<T extends Record<string, unknown> = Record<string, unknown>>(
  ownerUrl: string,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, [...params])).rows;
  } finally {
    await client.end();
  }
}
