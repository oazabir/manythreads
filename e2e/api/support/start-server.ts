// Starts the manythreads server for the `api` Playwright project against a fresh database, and drops it on exit.
// Run by playwright.config.ts (webServer): `tsx e2e/api/support/start-server.ts`.
import { createTestDatabase, dropTestDatabase, withClusterLock } from '@manythreads/test-utils';
import { startServer } from '@manythreads/server';

const port = Number(process.env['MANYTHREADS_API_PORT'] ?? 3100);
const db = await createTestDatabase({ migrate: false });
const server = await startServer({
  port,
  ownerUrl: db.ownerUrl,
  appUrl: db.appUrl,
  systemUrl: db.systemUrl,
  migrationLock: withClusterLock,
  testPlugins: process.env['MANYTHREADS_TEST_PLUGINS'] === '1',
  devAuth: true,
});
console.log(`manythreads api test server on ${server.url} (database ${db.name})`);

let closing = false;
const stop = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    await dropTestDatabase(db).catch(() => undefined);
    process.exit(0);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
