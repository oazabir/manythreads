import { DEFAULT_APP_PASSWORD, DEFAULT_SYSTEM_PASSWORD, DEV_OWNER_URL } from '@manythreads/kernel';

export interface DatabaseUrls {
  ownerUrl: string;
  appUrl: string;
  systemUrl: string;
  appPassword: string;
  systemPassword: string;
}

function deriveUrl(owner: string, user: string, password: string): string {
  const u = new URL(owner);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * The three database logins from the environment (one place for the server and the admin CLI):
 * `DATABASE_URL` is manythreads_owner; the app and system URLs are derived from it with their role passwords unless
 * `MANYTHREADS_APP_DATABASE_URL` / `MANYTHREADS_SYSTEM_DATABASE_URL` name them.
 */
export function databaseUrlsFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseUrls {
  const ownerUrl = env['DATABASE_URL'] ?? env['MANYTHREADS_DATABASE_URL'] ?? DEV_OWNER_URL;
  const appPassword = env['MANYTHREADS_APP_PASSWORD'] ?? DEFAULT_APP_PASSWORD;
  const systemPassword = env['MANYTHREADS_SYSTEM_PASSWORD'] ?? DEFAULT_SYSTEM_PASSWORD;
  return {
    ownerUrl,
    appUrl: env['MANYTHREADS_APP_DATABASE_URL'] ?? deriveUrl(ownerUrl, 'manythreads_app', appPassword),
    systemUrl: env['MANYTHREADS_SYSTEM_DATABASE_URL'] ?? deriveUrl(ownerUrl, 'manythreads_system', systemPassword),
    appPassword,
    systemPassword,
  };
}
