import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 random bits as base64url: the cookie value. Opaque: it carries no data and means nothing without the database. */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

/** What the database stores: sha256 of the token. A database leak does not yield usable cookies. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/**
 * The CSRF token bound to a session token (double-submit, but verified against the session, not just against the
 * cookie): sha256 of a domain-separated token. An attacker who can set cookies still cannot compute it.
 */
export const csrfTokenFor = (sessionToken: string): string =>
  createHash('sha256').update(`manythreads-csrf:${sessionToken}`).digest('base64url');

/** Constant-time string equality (false on a length mismatch, without leaking where strings differ). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
