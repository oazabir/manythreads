import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './config.ts';
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
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reads the session cookie and, when it resolves, sets `req.actor` and `req.authSession` (and rotated cookies on the
 * reply). A cookie that no longer resolves (idle, expired, revoked, suspended, unknown) leaves the request anonymous
 * and is flagged so `finishSessionCookies` can clear it from the browser.
 */
export async function authenticateCookie(req: FastifyRequest, reply: FastifyReply, sessions: SessionService): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const result = await sessions.resolve(token);
  if (!result.ok) {
    req.staleSessionCookie = true;
    return;
  }
  const s = result.session;
  req.actor = s.actor;
  req.authSession = { sessionId: s.sessionId, personId: s.personId, workspaceId: s.workspaceId, token: s.token, expiresAt: s.expiresAt };
  if (s.rotated) setSessionCookies(reply, s.rotated, sessions.config);
}

/** onSend: clear a dead session cookie unless the route already replaced it (sign-in sets a new one). */
export function finishSessionCookies(req: FastifyRequest, reply: FastifyReply, sessions: SessionService): void {
  if (!req.staleSessionCookie) return;
  const header = reply.getHeader('set-cookie');
  const list = Array.isArray(header) ? header : typeof header === 'string' ? [header] : [];
  if (list.some((c) => c.startsWith(`${SESSION_COOKIE}=`))) return;
  clearSessionCookies(reply, sessions.config);
}

/**
 * Double-submit CSRF for cookie-authenticated unsafe requests: the `x-csrf-token` header must equal the readable
 * `manythreads_csrf` cookie AND the token derived from this session's token, so a forged cookie is not enough.
 * Requests without a cookie session (dev header, anonymous) are not subject to it: there is nothing to forge.
 */
export function csrfAllows(req: FastifyRequest): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  if (!req.authSession || req.routeOptions.config.csrfExempt === true) return true;
  const header = req.headers[CSRF_HEADER];
  const cookie = req.cookies[CSRF_COOKIE];
  if (typeof header !== 'string' || typeof cookie !== 'string' || header === '') return false;
  return safeEqual(header, cookie) && safeEqual(header, csrfTokenFor(req.authSession.token));
}
