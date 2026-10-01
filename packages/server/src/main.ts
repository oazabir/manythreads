import { DEFAULT_APP_PASSWORD, DEFAULT_SYSTEM_PASSWORD, DEV_OWNER_URL } from '@manythreads/kernel';
import { startServer } from './start.ts';

/**
 * Environment:
 *   PORT                      listen port (3000)
 *   DATABASE_URL              manythreads_owner URL, used for migrations (dev default: the compose Postgres)
 *   MANYTHREADS_APP_DATABASE_URL   manythreads_app URL; derived from DATABASE_URL when unset
 *   MANYTHREADS_APP_PASSWORD       password for manythreads_app (set by the migration runner; default is dev-only)
 *   MANYTHREADS_SYSTEM_DATABASE_URL / MANYTHREADS_SYSTEM_PASSWORD   same for the kernel's manythreads_system login
 *   MANYTHREADS_TEST_PLUGINS=1     also load test-kernel and example-hello
 *   MANYTHREADS_DEV_AUTH=1         accept the x-manythreads-dev-actor header (never in production; phase 2 removes it)
 */
const env = process.env;
const ownerUrl = env['DATABASE_URL'] ?? env['MANYTHREADS_DATABASE_URL'] ?? DEV_OWNER_URL;
const appPassword = env['MANYTHREADS_APP_PASSWORD'] ?? DEFAULT_APP_PASSWORD;

const systemPassword = env['MANYTHREADS_SYSTEM_PASSWORD'] ?? DEFAULT_SYSTEM_PASSWORD;

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
  appUrl: env['MANYTHREADS_APP_DATABASE_URL'] ?? deriveUrl(ownerUrl, 'manythreads_app', appPassword),
  systemUrl: env['MANYTHREADS_SYSTEM_DATABASE_URL'] ?? deriveUrl(ownerUrl, 'manythreads_system', systemPassword),
  appPassword,
  testPlugins: env['MANYTHREADS_TEST_PLUGINS'] === '1',
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
