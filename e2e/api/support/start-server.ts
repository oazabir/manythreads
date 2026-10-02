// Starts the manythreads server for the `api` Playwright project against a fresh database, and drops it on exit.
// Run by playwright.config.ts (webServer): `tsx e2e/api/support/start-server.ts`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonas, createTestDatabase, dropTestDatabase, withClusterLock } from '@manythreads/test-utils';
import { startServer } from '@manythreads/server';

const port = Number(process.env['MANYTHREADS_API_PORT'] ?? 3100);
// Attachments (storage-local) go to a directory of their own, removed on exit, never into the working tree.
const storageDir = process.env['MANYTHREADS_STORAGE_DIR'] ?? mkdtempSync(join(tmpdir(), 'manythreads-e2e-blobs-'));
process.env['MANYTHREADS_STORAGE_DIR'] = storageDir;
// Team repositories (repo-git) likewise.
const repoDir = process.env['MANYTHREADS_REPO_DIR'] ?? mkdtempSync(join(tmpdir(), 'manythreads-e2e-repos-'));
process.env['MANYTHREADS_REPO_DIR'] = repoDir;
// Kernel migrations first so the seed world (workspace Kahf Software and the seven personas) exists before the server
// starts: no first-admin link is needed, and specs sign in as a persona through POST /api/test/session.
const db = await createTestDatabase();
await createPersonas(db);
const server = await startServer({
  port,
  ownerUrl: db.ownerUrl,
  appUrl: db.appUrl,
  systemUrl: db.systemUrl,
  migrationLock: withClusterLock,
  testPlugins: process.env['MANYTHREADS_TEST_PLUGINS'] === '1',
  devAuth: true,
  testAuthToken: process.env['MANYTHREADS_TEST_AUTH_TOKEN'] ?? 'e2e-test-auth-token',
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
    rmSync(storageDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    process.exit(0);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
