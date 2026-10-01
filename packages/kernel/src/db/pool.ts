import pg from 'pg';

export const DEV_OWNER_URL = 'postgresql://majlis_owner:majlis@localhost:55432/majlis';
export const DEV_APP_URL = 'postgresql://majlis_app:majlis_app@localhost:55432/majlis';

export function ownerDatabaseUrl(): string {
  return process.env['MAJLIS_DATABASE_URL'] ?? DEV_OWNER_URL;
}

export function appDatabaseUrl(): string {
  return process.env['MAJLIS_APP_DATABASE_URL'] ?? DEV_APP_URL;
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

let ownerPool: pg.Pool | undefined;
let appPool: pg.Pool | undefined;

export function getOwnerPool(): pg.Pool {
  return (ownerPool ??= createOwnerPool());
}

export function getAppPool(): pg.Pool {
  return (appPool ??= createAppPool());
}

export async function closePools(): Promise<void> {
  const pools = [ownerPool, appPool];
  ownerPool = undefined;
  appPool = undefined;
  await Promise.all(pools.map((p) => p?.end()));
}
