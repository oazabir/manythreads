import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryMailer, type MemoryMailer } from '@manythreads/kernel';
import { startServer, type RunningServer, type StartServerOptions } from '@manythreads/server';
import { createTestDatabase, dropTestDatabase, withClusterLock, type TestDatabase } from './db.ts';

export interface TestServer extends RunningServer {
  db: TestDatabase;
  /** Every mail the server sent (reset, verify, invite), in memory. */
  mailer: MemoryMailer;
  /** Log lines (JSON) captured while the server ran, newest last. Empty when a `logger` option was given. */
  logs: string[];
  /** The one-time first-admin token from the start-up log line, or undefined once no workspace needed one. */
  bootstrapToken(): string | undefined;
}

export type StartTestServerOptions = Partial<
  Pick<StartServerOptions, 'testPlugins' | 'devAuth' | 'logger' | 'port' | 'now' | 'session' | 'testAuthToken' | 'publicUrl' | 'jobWorkers' | 'jobPollMs' | 'storage'>
>;

/** Pulls the token out of the `first-admin setup: open <url>/bootstrap/<token> ...` log line. */
export function parseBootstrapToken(lines: readonly string[]): string | undefined {
  for (const line of [...lines].reverse()) {
    const m = /first-admin setup: open \S*\/bootstrap\/([A-Za-z0-9_-]+)/.exec(line);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * A fresh migrated test database plus a server on a random port (port 0) with the dev header actor enabled.
 * `close()` stops the server and drops the database.
 */
export async function startTestServer(options: StartTestServerOptions = {}): Promise<TestServer> {
  const db = await createTestDatabase({ migrate: false });
  const logs: string[] = [];
  const mailer = createMemoryMailer();
  // Team repositories (repo-git) go to a directory of this server, removed on close: team ids are fixed in the seed, so a directory shared
  // between databases would hand one test the repository of another.
  const repoDir = mkdtempSync(join(tmpdir(), 'manythreads-test-repos-'));
  process.env['MANYTHREADS_REPO_DIR'] = repoDir;
  try {
    const server = await startServer({
      port: options.port ?? 0,
      ownerUrl: db.ownerUrl,
      appUrl: db.appUrl,
      systemUrl: db.systemUrl,
      migrationLock: withClusterLock,
      testPlugins: options.testPlugins ?? true,
      // The environment must not pick the store either: local unless a test asks for s3.
      storage: options.storage ?? 'local',
      devAuth: options.devAuth ?? true,
      mailer,
      // The environment must not leak into tests: the test endpoint exists only when a test asks for it.
      testAuthToken: options.testAuthToken ?? null,
      publicUrl: options.publicUrl ?? 'http://localhost:3000',
      ...(options.now ? { now: options.now } : {}),
      ...(options.jobWorkers !== undefined ? { jobWorkers: options.jobWorkers } : {}),
      // Poll fast so a test does not wait out the production interval (NOTIFY wakes the worker anyway).
      jobPollMs: options.jobPollMs ?? 200,
      ...(options.session ? { session: options.session } : {}),
      logger: options.logger ?? {
        level: 'info',
        stream: { write: (line: string) => void (logs.length < 5000 && logs.push(line)) },
      },
    });
    return {
      ...server,
      db,
      mailer,
      logs,
      bootstrapToken: () => parseBootstrapToken(logs),
      async close() {
        await server.close();
        await dropTestDatabase(db);
        rmSync(repoDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await dropTestDatabase(db);
    rmSync(repoDir, { recursive: true, force: true });
    throw err;
  }
}
