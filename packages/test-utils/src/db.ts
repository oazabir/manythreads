import { randomBytes } from 'node:crypto';
import {
  DEFAULT_APP_PASSWORD,
  DEFAULT_SYSTEM_PASSWORD,
  kernelMigrationSource,
  runMigrations,
  type MigrationSource,
} from '@majlis/kernel';
import pg from 'pg';

export const DEV_TEST_DATABASE_URL = 'postgresql://majlis_owner:majlis@localhost:55432/majlis';

/** Owner connection string of the cluster's admin database; tests create and drop temp databases through it. */
export function testAdminUrl(): string {
  return process.env['MAJLIS_TEST_DATABASE_URL'] ?? DEV_TEST_DATABASE_URL;
}

export interface TestDatabase {
  name: string;
  /** Owner (majlis_owner) connection string to the temp database. */
  ownerUrl: string;
  /** majlis_app connection string to the temp database. */
  appUrl: string;
  /** majlis_system connection string to the temp database (the only login for which app.is_system() is true). */
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

/** Creates a fresh `majlis_test_*` database and (by default) migrates it. Drop it with dropTestDatabase. */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = testAdminUrl();
  const name = `majlis_test_${randomBytes(6).toString('hex')}`;
  const ownerUrl = withDatabase(adminUrl, name);
  const appUrl = withDatabase(adminUrl, name, { name: 'majlis_app', password: DEFAULT_APP_PASSWORD });
  const systemUrl = withDatabase(adminUrl, name, { name: 'majlis_system', password: DEFAULT_SYSTEM_PASSWORD });
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
  if (!/^majlis_test_[0-9a-f]+$/.test(db.name)) throw new Error(`Refusing to drop ${db.name}`);
  const admin = new pg.Client({ connectionString: testAdminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${db.name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Names of tables in schema `app` that break the RLS rule (PLAN.md D3, P1-04): not on the `global_tables`
 * allowlist and missing ENABLE, FORCE or at least one policy. Run it as the owner.
 */
export async function findRlsViolations(client: {
  query(text: string): Promise<{ rows: { name: string }[] }>;
}): Promise<string[]> {
  const result = await client.query(`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND c.relname NOT IN (SELECT name FROM app.global_tables)
      AND (NOT c.relrowsecurity
           OR NOT c.relforcerowsecurity
           OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
    ORDER BY c.relname
  `);
  return result.rows.map((r) => r.name);
}
