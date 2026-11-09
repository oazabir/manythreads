// Saved starting points for the persona journeys (PLAN P12-02, Bundle E decision E29). A snapshot is a seeded database kept as a Postgres template plus a tar of
// the stack's repository and file folders; restoring one is `CREATE DATABASE ... TEMPLATE ...` and an untar, not a re-seed.
//
// e2e/fixtures/stack-server.ts calls `restoreSnapshot` when `MANYTHREADS_STACK_SNAPSHOT` is set. It never falls back to seeding: a spec that asks for a snapshot
// that cannot be restored fails with the reason, so it never runs on the wrong data.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { testAdminUrl, testClient } from '../../../packages/test-utils/src/index.ts';
import { isSnapshotName, SNAPSHOT_LIST } from './definitions.ts';
import { computeSnapshotHash } from './hash.ts';
import { snapshotDatabaseName, snapshotExists, snapshotFiles } from './store.ts';

export interface RestoreSnapshotOptions {
  /** `day-1` or `week-2`. */
  name: string;
  /** The stack's fresh, empty (migrated or not) database, from `createTestDatabase`. It is replaced, under the same name, by a copy of the snapshot. */
  database: { name: string; ownerUrl: string };
  /** The folders the stack points `MANYTHREADS_REPO_DIR` and `MANYTHREADS_STORAGE_DIR` at; the tar is unpacked into them. */
  repoDir: string;
  storageDir: string;
  /** Build the snapshot first when it is missing or out of date (default true; `MANYTHREADS_SNAPSHOT_AUTOBUILD=0` turns it off). */
  autoBuild?: boolean;
  /** The hash the snapshot is looked up under (default: the current one, from the migrations and seed sources). A test seam: it lets a test keep a small fake snapshot of its own. */
  hash?: string;
  log?: (line: string) => void;
}

export interface RestoreResult {
  millis: number;
  snapshotDatabase: string;
  /** True when the snapshot had to be built first (the time then includes the build). */
  built: boolean;
}

/** `CREATE DATABASE ... TEMPLATE` needs the template to have no other session, so two restores of one snapshot take turns. */
const RESTORE_LOCK_KEY = 7_450_012;

export async function restoreSnapshot(options: RestoreSnapshotOptions): Promise<RestoreResult> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  if (!isSnapshotName(options.name)) throw new Error(`MANYTHREADS_STACK_SNAPSHOT=${options.name}: unknown snapshot (known: ${SNAPSHOT_LIST})`);
  // only a throwaway test database is ever replaced
  if (!/^manythreads_test_[0-9a-f]+$/.test(options.database.name)) throw new Error(`restoreSnapshot refuses to replace ${options.database.name}`);
  const snapshotDatabase = snapshotDatabaseName(options.name, options.hash ?? computeSnapshotHash());
  let built = false;
  if (!(await snapshotExists(snapshotDatabase))) {
    const allowed = options.autoBuild ?? process.env['MANYTHREADS_SNAPSHOT_AUTOBUILD'] !== '0';
    if (!allowed) {
      throw new Error(
        `MANYTHREADS_STACK_SNAPSHOT=${options.name}: the snapshot is not built, or it is out of date (the migrations or seeds changed). ` +
          `Build it with: pnpm --filter @manythreads/tools-seed snapshot build ${options.name}`,
      );
    }
    log(`snapshot ${options.name} is missing or stale: building it first`);
    const { buildSnapshot } = await import('./build.ts');
    await buildSnapshot(options.name, { log });
    built = true;
  }
  const admin = testClient({ connectionString: testAdminUrl() });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [RESTORE_LOCK_KEY]);
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${options.database.name}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${options.database.name}" TEMPLATE "${snapshotDatabase}"`);
      // A database's own settings are not copied from the template: the two logins find their tables through this search path (kernel migrations 0001, 0003).
      for (const role of ['manythreads_app', 'manythreads_system']) {
        await admin.query(`ALTER ROLE ${role} IN DATABASE "${options.database.name}" SET search_path = app, public`);
        await admin.query(`GRANT CONNECT ON DATABASE "${options.database.name}" TO ${role}`);
      }
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [RESTORE_LOCK_KEY]);
    }
  } finally {
    await admin.end();
  }
  const files = snapshotFiles(snapshotDatabase);
  for (const [tarFile, dir] of [[files.repos, options.repoDir], [files.blobs, options.storageDir]] as const) {
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['-xf', tarFile, '-C', dir], { stdio: 'pipe' });
  }
  const millis = Date.now() - started;
  log(`restored ${options.name} in ${millis} ms`);
  return { millis, snapshotDatabase, built };
}
