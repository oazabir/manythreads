import type { IssuedSession } from '@manythreads/sdk';
import type { FastifyReply } from 'fastify';
import { CSRF_COOKIE, SESSION_COOKIE, type SessionConfig } from './config.ts';

/**
 * Sets both cookies: the session token (HttpOnly, so scripts never see it) and the CSRF token (readable on purpose:
 * the web client copies it into the `x-csrf-token` header). SameSite=Lax on both; Secure per `SessionConfig`.
 * Both last until the session's absolute expiry; the server decides earlier ends (idle) itself.
 */
export function setSessionCookies(reply: FastifyReply, issued: IssuedSession, config: SessionConfig): void {
  const expires = new Date(issued.expiresAt);
  const base = { path: '/', sameSite: 'lax' as const, secure: config.secureCookies, expires };
  void reply.setCookie(SESSION_COOKIE, issued.token, { ...base, httpOnly: true });
  void reply.setCookie(CSRF_COOKIE, issued.csrfToken, { ...base, httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply, config: SessionConfig): void {
  const base = { path: '/', sameSite: 'lax' as const, secure: config.secureCookies, expires: new Date(0), maxAge: 0 };
  void reply.setCookie(SESSION_COOKIE, '', { ...base, httpOnly: true });
  void reply.setCookie(CSRF_COOKIE, '', { ...base, httpOnly: false });
}
