import { changePasswordRoute, getSessionRoute, signOutEverywhereRoute, signOutRoute } from '@manythreads/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER, cookieNames } from './config.ts';
import { clearSessionCookies, setSessionCookies } from './cookies.ts';
import type { SessionService } from './service.ts';
import { csrfTokenFor, safeEqual } from './tokens.ts';

/** The cookie session a request arrived on (set by `authenticateCookie`). */
export interface RequestSession {
  sessionId: string;
  personId: string;
  workspaceId: string;
  /** The presented token; only used to verify the CSRF token bound to it. Never log it. */
  token: string;
  expiresAt: Date;
  /** The person still has the password that was made up for them: see `mustChangeRefusal`. */
  mustChangePassword: boolean;
  /** Name of the readable CSRF cookie that belongs to the cookie this session was read from. */
  csrfCookie: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reads the session cookie and, when it resolves, sets `req.actor` and `req.authSession` (and rotated cookies on the
 * reply). A cookie that no longer resolves (idle, expired, revoked, suspended, unknown) leaves the request anonymous
 * and is flagged so `finishSessionCookies` can clear it from the browser.
 */
export async function authenticateCookie(req: FastifyRequest, reply: FastifyReply, sessions: SessionService): Promise<void> {
  const names = cookieNames(sessions.config.secureCookies);
  const token = req.cookies[names.session];
  const csrfCookie = names.csrf;
  if (!token) return;
  const result = await sessions.resolve(token);
  if (!result.ok) {
    req.staleSessionCookie = true;
    return;
  }
  const s = result.session;
  req.actor = s.actor;
  req.authSession = { sessionId: s.sessionId, personId: s.personId, workspaceId: s.workspaceId, token: s.token, expiresAt: s.expiresAt, mustChangePassword: s.mustChangePassword, csrfCookie };
  if (s.rotated) setSessionCookies(reply, s.rotated, sessions.config);
}

/** What a person who has not yet replaced the password made up for them may still call: read the session, change the password, sign out. */
const MUST_CHANGE_ALLOWED: ReadonlySet<string> = new Set([
  `${getSessionRoute.method} ${getSessionRoute.path}`,
  `${changePasswordRoute.method} ${changePasswordRoute.path}`,
  `${signOutRoute.method} ${signOutRoute.path}`,
  `${signOutEverywhereRoute.method} ${signOutEverywhereRoute.path}`,
]);

/**
 * The first-password rule, kept by the server and not only by the web page: while the signed-in person's password is the one made up for them, every `/api` call
 * but the three above is refused with 403 `password_change_required`, so the password printed at install time gives no access until it has been changed.
 * Answers true when the request must be refused. Only cookie sessions are subject to it (a dev header or an app token names no password).
 */
export function mustChangeRefusal(req: FastifyRequest): boolean {
  if (!req.authSession?.mustChangePassword) return false;
  // A public route is one that names its own credential (a token, a signature) or none at all; it does not act with the session.
  if (req.routeOptions?.config?.public === true) return false;
  const path = (req.routeOptions?.url ?? req.url).split('?')[0] ?? '';
  if (!path.startsWith('/api/')) return false;
  return !MUST_CHANGE_ALLOWED.has(`${req.method} ${path}`);
}

/** onSend: clear a dead session cookie unless the route already replaced it (sign-in sets a new one). */
export function finishSessionCookies(req: FastifyRequest, reply: FastifyReply, sessions: SessionService): void {
  if (!req.staleSessionCookie) return;
  const header = reply.getHeader('set-cookie');
  const list = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  const name = cookieNames(sessions.config.secureCookies).session;
  if (list.some((c) => c.startsWith(`${name}=`))) return;
  clearSessionCookies(reply, sessions.config);
}

/**
 * Double-submit CSRF for cookie-authenticated unsafe requests: the `x-csrf-token` header must equal the readable
 * `manythreads_csrf` cookie (the `__Host-` one for a Secure server; the cookie matching the session cookie in use) AND the token derived from this session's token, so a forged cookie is not enough.
 * Requests without a cookie session (dev header, anonymous) are not subject to it: there is nothing to forge.
 */
export function csrfAllows(req: FastifyRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  if (!req.authSession || req.routeOptions.config.csrfExempt === true) return true;
  const header = req.headers[CSRF_HEADER];
  const cookie = req.cookies[req.authSession.csrfCookie];
  if (typeof header !== 'string' || typeof cookie !== 'string' || header === '') return false;
  return safeEqual(header, cookie) && safeEqual(header, csrfTokenFor(req.authSession.token));
}
