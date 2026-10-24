/** Session lifetimes and cookie flags. Every number can be set from the environment (see `sessionConfigFromEnv`). */
export interface SessionConfig {
  /** A session with no request for this long ends (default 30 minutes). */
  idleMs: number;
  /** A session ends this long after sign-in whatever happens (default 30 days). */
  absoluteMs: number;
  /** The cookie token is replaced when it is older than this (default 4 hours). */
  rotateMs: number;
  /** After rotation the previous token still works for this long (parallel requests; default 60 seconds). */
  rotationGraceMs: number;
  /** `Secure` flag on both cookies. */
  secureCookies: boolean;
}

/**
 * Plain cookie names: used when cookies are not Secure (local http). On a Secure server they are never read (only expired).
 * With Secure cookies the names carry the `__Host-` prefix (see `cookieNames`).
 */
export const SESSION_COOKIE = 'manythreads_session';
export const CSRF_COOKIE = 'manythreads_csrf';

/**
 * Why the prefix: apps that bots deploy live on subdomains of the platform host, and a subdomain can set a cookie with
 * `Domain=<platform host>` that the browser then sends to the platform ("cookie tossing": log people out, fix a
 * session id, shadow the CSRF cookie). A `__Host-` cookie must be Secure, host-only and Path=/, so the browser
 * refuses it from any subdomain and from any `Domain=` attribute. It needs Secure, so plain http keeps the plain names.
 */
export function cookieNames(secure: boolean): { session: string; csrf: string } {
  return secure ? { session: `__Host-${SESSION_COOKIE}`, csrf: `__Host-${CSRF_COOKIE}` } : { session: SESSION_COOKIE, csrf: CSRF_COOKIE };
}
export const CSRF_HEADER = 'x-csrf-token';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_SESSION_CONFIG: Omit<SessionConfig, 'secureCookies'> = {
  idleMs: 30 * MINUTE,
  absoluteMs: 30 * DAY,
  rotateMs: 4 * HOUR,
  rotationGraceMs: MINUTE,
};

export interface SessionEnv {
  NODE_ENV?: string | undefined;
  MANYTHREADS_PUBLIC_URL?: string | undefined;
  MANYTHREADS_COOKIE_SECURE?: string | undefined;
  MANYTHREADS_SESSION_IDLE_MINUTES?: string | undefined;
  MANYTHREADS_SESSION_ABSOLUTE_DAYS?: string | undefined;
  MANYTHREADS_SESSION_ROTATE_HOURS?: string | undefined;
}

const positive = (raw: string | undefined, unitMs: number, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * unitMs) : fallback;
};

/**
 * Cookies are `Secure` except when the server is plainly local: NODE_ENV=test or development, or a public URL that
 * starts with http:// (a self-host without TLS). MANYTHREADS_COOKIE_SECURE=1|0 overrides all of that.
 */
export function sessionConfigFromEnv(env: SessionEnv = process.env): SessionConfig {
  const override = env.MANYTHREADS_COOKIE_SECURE;
  const local = env.NODE_ENV === 'test' || env.NODE_ENV === 'development' || /^http:\/\//i.test(env.MANYTHREADS_PUBLIC_URL ?? '');
  const secureCookies = override === '1' || override === 'true' ? true : override === '0' || override === 'false' ? false : !local;
  return {
    idleMs: positive(env.MANYTHREADS_SESSION_IDLE_MINUTES, MINUTE, DEFAULT_SESSION_CONFIG.idleMs),
    absoluteMs: positive(env.MANYTHREADS_SESSION_ABSOLUTE_DAYS, DAY, DEFAULT_SESSION_CONFIG.absoluteMs),
    rotateMs: positive(env.MANYTHREADS_SESSION_ROTATE_HOURS, HOUR, DEFAULT_SESSION_CONFIG.rotateMs),
    rotationGraceMs: DEFAULT_SESSION_CONFIG.rotationGraceMs,
    secureCookies,
  };
}
