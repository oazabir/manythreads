import pg from 'pg';

export const DEV_OWNER_URL = 'postgresql://majlis_owner:majlis@localhost:55432/majlis';
export const DEV_APP_URL = 'postgresql://majlis_app:majlis_app@localhost:55432/majlis';

export const DEV_SYSTEM_URL = 'postgresql://majlis_system:majlis_system@localhost:55432/majlis';

export function ownerDatabaseUrl(): string {
  return process.env['MAJLIS_DATABASE_URL'] ?? DEV_OWNER_URL;
}

export function appDatabaseUrl(): string {
  return process.env['MAJLIS_APP_DATABASE_URL'] ?? DEV_APP_URL;
}

/**
 * Connection string for the majlis_system role: MAJLIS_SYSTEM_DATABASE_URL, else the app URL (when
 * MAJLIS_APP_DATABASE_URL is set) with the credentials swapped for majlis_system / MAJLIS_SYSTEM_PASSWORD
 * (dev default 'majlis_system'), else the dev URL.
 */
export function systemDatabaseUrl(): string {
  const explicit = process.env['MAJLIS_SYSTEM_DATABASE_URL'];
  if (explicit) return explicit;
  const app = process.env['MAJLIS_APP_DATABASE_URL'];
  if (!app) return DEV_SYSTEM_URL;
  const u = new URL(app);
  u.username = 'majlis_system';
  u.password = process.env['MAJLIS_SYSTEM_PASSWORD'] ?? 'majlis_system';
  return u.toString();
}

function track(pool: pg.Pool): pg.Pool {
  // An idle client dying (server restart) must not crash the process.
  pool.on('error', () => undefined);
  return pool;
}

/** Pool connecting as majlis_owner; for migrations and admin only, never for request handling. */
export function createOwnerPool(connectionString: string = ownerDatabaseUrl(), max = 2): pg.Pool {
  return track(new pg.Pool({ connectionString, max }));
}

/** Pool connecting as majlis_app (NOBYPASSRLS); the only pool request code touches, through withActor. */
export function createAppPool(connectionString: string = appDatabaseUrl(), max = 10): pg.Pool {
  return track(new pg.Pool({ connectionString, max }));
}

/**
 * Pool connecting as majlis_system (NOBYPASSRLS, but app.is_system() is true for it); only withSystem and kernel
 * workers (jobs, outbox) use it. Never hand it to request code.
 */
export function createSystemPool(connectionString: string = systemDatabaseUrl(), max = 10): pg.Pool {
  return track(new pg.Pool({ connectionString, max }));
}

let ownerPool: pg.Pool | undefined;
let appPool: pg.Pool | undefined;
let systemPool: pg.Pool | undefined;

export function getOwnerPool(): pg.Pool {
  return (ownerPool ??= createOwnerPool());
}

export function getAppPool(): pg.Pool {
  return (appPool ??= createAppPool());
}

export function getSystemPool(): pg.Pool {
  return (systemPool ??= createSystemPool());
}

export async function closePools(): Promise<void> {
  const pools = [ownerPool, appPool, systemPool];
  ownerPool = undefined;
  appPool = undefined;
  systemPool = undefined;
  await Promise.all(pools.map((p) => p?.end()));
}
