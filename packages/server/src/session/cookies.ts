import type { IssuedSession } from '@manythreads/sdk';
import type { FastifyReply } from 'fastify';
import { CSRF_COOKIE, SESSION_COOKIE, cookieNames, type SessionConfig } from './config.ts';

/** Expires the plain-named cookies of the pre-`__Host-` releases (only relevant when cookies are Secure). */
function expireLegacy(reply: FastifyReply, config: SessionConfig): void {
  if (!config.secureCookies) return;
  const base = { path: '/', sameSite: 'lax' as const, secure: true, expires: new Date(0), maxAge: 0 };
  void reply.setCookie(SESSION_COOKIE, '', { ...base, httpOnly: true });
  void reply.setCookie(CSRF_COOKIE, '', { ...base, httpOnly: false });
}

/**
 * Sets both cookies: the session token (HttpOnly, so scripts never see it) and the CSRF token (readable on purpose:
 * the web client copies it into the `x-csrf-token` header). SameSite=Lax on both; Secure per `SessionConfig`, and then
 * named with `__Host-` (see `cookieNames`). Both last until the session's absolute expiry; the server decides earlier
 * ends (idle) itself. Also expires the legacy plain-named pair so a browser never holds both.
 */
export function setSessionCookies(reply: FastifyReply, issued: IssuedSession, config: SessionConfig): void {
  const names = cookieNames(config.secureCookies);
  const expires = new Date(issued.expiresAt);
  const base = { path: '/', sameSite: 'lax' as const, secure: config.secureCookies, expires };
  void reply.setCookie(names.session, issued.token, { ...base, httpOnly: true });
  void reply.setCookie(names.csrf, issued.csrfToken, { ...base, httpOnly: false });
  expireLegacy(reply, config);
}

export function clearSessionCookies(reply: FastifyReply, config: SessionConfig): void {
  const names = cookieNames(config.secureCookies);
  const base = { path: '/', sameSite: 'lax' as const, secure: config.secureCookies, expires: new Date(0), maxAge: 0 };
  void reply.setCookie(names.session, '', { ...base, httpOnly: true });
  void reply.setCookie(names.csrf, '', { ...base, httpOnly: false });
  expireLegacy(reply, config);
}
