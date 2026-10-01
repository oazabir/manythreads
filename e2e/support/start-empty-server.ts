// Starts a manythreads server on an EMPTY database for the bootstrap spec and writes the one-time first-admin token to
// e2e/.auth/bootstrap-token.txt. Run by playwright.config.ts (webServer); the database is dropped on exit.
import { mkdirSync, writeFileSync } from 'node:fs';
import { startTestServer } from '@manythreads/test-utils';
import { API_EMPTY_PORT, AUTH_DIR, BOOTSTRAP_TOKEN_FILE, WEB_EMPTY } from './ports.ts';

const server = await startTestServer({ port: Number(process.env['MANYTHREADS_API_PORT'] ?? API_EMPTY_PORT), publicUrl: WEB_EMPTY, testPlugins: false, devAuth: false });
const token = server.bootstrapToken();
if (!token) throw new Error('the empty server printed no first-admin link');
mkdirSync(AUTH_DIR, { recursive: true });
writeFileSync(BOOTSTRAP_TOKEN_FILE, token);
console.log(`manythreads empty test server on ${server.url} (database ${server.db.name}); first-admin link ${WEB_EMPTY}/bootstrap/${token}`);

let closing = false;
const stop = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
