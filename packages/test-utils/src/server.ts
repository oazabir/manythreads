import { startServer, type RunningServer, type StartServerOptions } from '@manythreads/server';
import { createTestDatabase, dropTestDatabase, withClusterLock, type TestDatabase } from './db.ts';

export interface TestServer extends RunningServer {
  db: TestDatabase;
}

export type StartTestServerOptions = Partial<Pick<StartServerOptions, 'testPlugins' | 'devAuth' | 'logger' | 'port'>>;

/**
 * A fresh migrated test database plus a server on a random port (port 0) with the dev header actor enabled.
 * `close()` stops the server and drops the database.
 */
export async function startTestServer(options: StartTestServerOptions = {}): Promise<TestServer> {
  const db = await createTestDatabase({ migrate: false });
  try {
    const server = await startServer({
      port: options.port ?? 0,
      ownerUrl: db.ownerUrl,
      appUrl: db.appUrl,
      systemUrl: db.systemUrl,
      migrationLock: withClusterLock,
      testPlugins: options.testPlugins ?? true,
      devAuth: options.devAuth ?? true,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
    return {
      ...server,
      db,
      async close() {
        await server.close();
        await dropTestDatabase(db);
      },
    };
  } catch (err) {
    await dropTestDatabase(db);
    throw err;
  }
}
