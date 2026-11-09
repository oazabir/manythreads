// Builds a snapshot: runs the seeds of a recipe (definitions.ts) on a fresh database through a real stack server, then keeps the database as a Postgres
// template (`mt_snap_<name>_<hash>`) and the stack's repository and file folders as two tars. Restoring (restore.ts) is a copy of the template and an untar.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SYSTEM_PASSWORD } from '../../../packages/kernel/src/index.ts';
import { dropTestDatabase, ownerSql, seedMeetings, seedWorld, testAdminUrl, withDatabase } from '../../../packages/test-utils/src/index.ts';
import { RECIPES, isSnapshotName, SNAPSHOT_LIST, type SnapshotName } from './definitions.ts';
import { REPO_ROOT, computeSnapshotHash } from './hash.ts';
import { withFileLock } from './lock.ts';
import { saveSnapshotDatabase, snapshotDatabaseName, snapshotDir, snapshotExists, snapshotFiles } from './store.ts';

const E2E_DIR = join(REPO_ROOT, 'e2e');
const STACK_SERVER = join(E2E_DIR, 'fixtures', 'stack-server.ts');
const START_BUDGET_MS = 180_000;

export interface BuildOptions {
  /** Build again even when a current snapshot exists. */
  force?: boolean;
  log?: (line: string) => void;
}

export interface BuildResult {
  name: SnapshotName;
  database: string;
  hash: string;
  /** False when a current snapshot already existed. */
  built: boolean;
  millis: number;
}

interface RunningStack {
  origin: string;
  database: string;
  ownerUrl: string;
  /** Kills the whole process group at once: the database is NOT dropped (the stack's own SIGTERM handler would drop it). */
  kill(): Promise<void>;
}

async function startBuilderStack(env: Record<string, string>, log: (line: string) => void): Promise<RunningStack> {
  const child = spawn('pnpm', ['exec', 'tsx', STACK_SERVER], {
    cwd: E2E_DIR,
    env: { ...process.env, NODE_ENV: 'test', MANYTHREADS_LINK_PREVIEW: 'off', MANYTHREADS_APP_POOL_MAX: '5', MANYTHREADS_SYSTEM_POOL_MAX: '5', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  const ready = await new Promise<{ origin: string; ownerUrl: string; database: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the snapshot stack did not start in time:\n${output.slice(-1500)}`)), START_BUDGET_MS);
    const onChunk = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const line = /MANYTHREADS_STACK (\{.*\})/.exec(output);
      if (line?.[1]) {
        clearTimeout(timer);
        resolve(JSON.parse(line[1]) as { origin: string; ownerUrl: string; database: string });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`the snapshot stack exited with ${code ?? signal} before it was ready:\n${output.slice(-1500)}`));
    });
  });
  log(`stack up at ${ready.origin} (database ${ready.database})`);
  return {
    ...ready,
    kill: async () => {
      child.removeAllListeners('exit');
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

/** Waits until nothing is connected to `database` (a killed server's backends take a moment to be noticed by Postgres). */
async function waitForNoSessions(database: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await ownerSql<{ n: string }>(testAdminUrl(), 'SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1', [database]);
    if (rows[0]?.n === '0') return;
    if (Date.now() > until) {
      await ownerSql(testAdminUrl(), 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [database]);
      await new Promise((r) => setTimeout(r, 500));
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function tar(create: string, from: string): void {
  execFileSync('tar', ['-cf', create, '-C', from, '.'], { stdio: 'pipe' });
}

export async function buildSnapshot(name: string, options: BuildOptions = {}): Promise<BuildResult> {
  if (!isSnapshotName(name)) throw new Error(`unknown snapshot "${name}" (known: ${SNAPSHOT_LIST})`);
  const log = options.log ?? (() => undefined);
  const hash = computeSnapshotHash();
  const database = snapshotDatabaseName(name, hash);
  const started = Date.now();
  return withFileLock(join(snapshotDir(), 'build.lock'), async () => {
    // another process may have built it while this one waited for the lock
    if (!options.force && (await snapshotExists(database))) return { name, database, hash, built: false, millis: Date.now() - started };
    const recipe = RECIPES[name];
    const work = mkdtempSync(join(tmpdir(), 'manythreads-snapshot-'));
    const repoDir = join(work, 'repos');
    const storageDir = join(work, 'blobs');
    for (const dir of [repoDir, storageDir]) execFileSync('mkdir', ['-p', dir]);
    // the seeds read these two, the stack server too
    process.env['MANYTHREADS_REPO_DIR'] = repoDir;
    process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
    let stack: RunningStack | null = null;
    try {
      log(`building ${name} (${recipe.describes}) as ${database}`);
      stack = await startBuilderStack(
        {
          MANYTHREADS_STACK_SEED: 'world',
          MANYTHREADS_STACK_API_ONLY: '1',
          MANYTHREADS_STACK_DEV_AUTH: '1',
          MANYTHREADS_REPO_DIR: repoDir,
          MANYTHREADS_STORAGE_DIR: storageDir,
          ...(recipe.meetings ? { MANYTHREADS_STACK_MEETINGS: '1' } : {}),
        },
        log,
      );
      const db = { systemUrl: withDatabase(stack.ownerUrl, stack.database, { name: 'manythreads_system', password: DEFAULT_SYSTEM_PASSWORD }) };
      if (recipe.content || recipe.repo || recipe.work) {
        const seeded = await seedWorld(db, { content: recipe.content, repo: recipe.repo, work: recipe.work, log: (line) => log(`seed: ${line}`) });
        if (seeded.skipped) throw new Error(`seedWorld skipped: ${seeded.skipped}`);
      }
      if (recipe.meetings) await seedMeetings({ url: stack.origin, db: { systemUrl: db.systemUrl }, log: (line) => log(`seed meetings: ${line}`) });
      // let the bots plugin and the outbox finish what the seeds started
      await new Promise((r) => setTimeout(r, 3000));
      await stack.kill();
      await waitForNoSessions(stack.database);
      await saveSnapshotDatabase(database, stack.database);
      const files = snapshotFiles(database);
      tar(files.repos, repoDir);
      tar(files.blobs, storageDir);
      log(`saved ${database}`);
      return { name, database, hash, built: true, millis: Date.now() - started };
    } finally {
      if (stack) {
        await stack.kill().catch(() => undefined);
        await dropTestDatabase({ name: stack.database, ownerUrl: stack.ownerUrl, appUrl: '', systemUrl: '', applied: 0 }).catch(() => undefined);
      }
      rmSync(work, { recursive: true, force: true });
    }
  });
}
