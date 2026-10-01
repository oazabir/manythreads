import { DEFAULT_APP_PASSWORD, DEFAULT_SYSTEM_PASSWORD, DEV_OWNER_URL } from '@majlis/kernel';
import { startServer } from './start.ts';

/**
 * Environment:
 *   PORT                      listen port (3000)
 *   DATABASE_URL              majlis_owner URL, used for migrations (dev default: the compose Postgres)
 *   MAJLIS_APP_DATABASE_URL   majlis_app URL; derived from DATABASE_URL when unset
 *   MAJLIS_APP_PASSWORD       password for majlis_app (set by the migration runner; default is dev-only)
 *   MAJLIS_SYSTEM_DATABASE_URL / MAJLIS_SYSTEM_PASSWORD   same for the kernel's majlis_system login
 *   MAJLIS_TEST_PLUGINS=1     also load test-kernel and example-hello
 *   MAJLIS_DEV_AUTH=1         accept the x-majlis-dev-actor header (never in production; phase 2 removes it)
 */
const env = process.env;
const ownerUrl = env['DATABASE_URL'] ?? env['MAJLIS_DATABASE_URL'] ?? DEV_OWNER_URL;
const appPassword = env['MAJLIS_APP_PASSWORD'] ?? DEFAULT_APP_PASSWORD;

const systemPassword = env['MAJLIS_SYSTEM_PASSWORD'] ?? DEFAULT_SYSTEM_PASSWORD;

function deriveUrl(owner: string, user: string, password: string): string {
  const u = new URL(owner);
  u.username = user;
  u.password = password;
  return u.toString();
}

const server = await startServer({
  port: Number(env['PORT'] ?? 3000),
  host: env['HOST'] ?? '0.0.0.0',
  ownerUrl,
  appUrl: env['MAJLIS_APP_DATABASE_URL'] ?? deriveUrl(ownerUrl, 'majlis_app', appPassword),
  systemUrl: env['MAJLIS_SYSTEM_DATABASE_URL'] ?? deriveUrl(ownerUrl, 'majlis_system', systemPassword),
  appPassword,
  testPlugins: env['MAJLIS_TEST_PLUGINS'] === '1',
  logger: true,
});

let closing = false;
const shutdown = (signal: string): void => {
  if (closing) return;
  closing = true;
  server.app.log.info({ signal }, 'shutting down');
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  server.close().then(
    () => process.exit(0),
    (err: unknown) => {
      server.app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    },
  );
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
