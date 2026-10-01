import type { OidcProviderKind, OidcSignInErrorCode } from '@manythreads/shared';

/** The id_token claims the sign-in rules read. Anything else in the token is ignored. */
export interface IdClaims {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  preferred_username?: unknown;
  /** Google Workspace hosted domain. */
  hd?: unknown;
  /** Microsoft Entra tenant id. */
  tid?: unknown;
  [claim: string]: unknown;
}

export interface RuleInput {
  kind: OidcProviderKind;
  /** Microsoft: the one tenant that may sign in. */
  tenantId: string | null;
  /** Lower-case bare domains; empty means "any domain" (never for Google). */
  allowedDomains: readonly string[];
  claims: IdClaims;
}

export type RuleOutcome =
  | { ok: true; subject: string; email: string; name: string }
  | { ok: false; reason: OidcSignInErrorCode; email: string | null };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const isTrue = (v: unknown): boolean => v === true || v === 'true';

/** The address the provider asserts: `email`, or for Microsoft the UPN in `preferred_username` when it is an address. */
function assertedEmail(kind: OidcProviderKind, claims: IdClaims): string | null {
  const email = str(claims.email);
  if (email && email.includes('@')) return email.toLowerCase();
  if (kind === 'microsoft') {
    const upn = str(claims.preferred_username);
    if (upn && upn.includes('@')) return upn.toLowerCase();
  }
  return null;
}

const displayName = (claims: IdClaims, email: string): string => {
  const full = str(claims.name) ?? [str(claims.given_name), str(claims.family_name)].filter(Boolean).join(' ');
  return (full || email.split('@')[0] || email).slice(0, 200);
};

/**
 * The provider-specific rules, in the order that gives the clearest refusal: tenant (Microsoft), domain (allowlist and,
 * for Google, the `hd` claim), then email verification. Pure: no I/O, so every refusal is unit-testable.
 *
 * - Google: `hd` must equal an allowed domain (a personal Gmail account has none) and so must the email's domain;
 *   `email_verified` must be true.
 * - Microsoft: `tid` must be the configured tenant. Entra does not send `email_verified`; the tenant pin is what makes
 *   the address trustworthy, so only an explicit `email_verified: false` is refused.
 * - Any OIDC: `email_verified` must be true; the domain list applies when it is not empty.
 */
export function evaluateClaims(input: RuleInput): RuleOutcome {
  const { kind, claims } = input;
  const email = assertedEmail(kind, claims);
  const refuse = (reason: OidcSignInErrorCode): RuleOutcome => ({ ok: false, reason, email });

  const subject = str(claims.sub);
  if (!subject) return refuse('token_invalid');

  if (kind === 'microsoft') {
    const tid = str(claims.tid)?.toLowerCase();
    if (!input.tenantId || tid !== input.tenantId.toLowerCase()) return refuse('tenant_not_allowed');
  }

  if (!email) return refuse('email_not_verified');
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const allowed = input.allowedDomains.map((d) => d.toLowerCase());

  if (kind === 'google') {
    const hd = str(claims.hd)?.toLowerCase();
    if (allowed.length === 0 || !hd || !allowed.includes(hd) || !allowed.includes(domain)) return refuse('domain_not_allowed');
  } else if (allowed.length > 0 && !allowed.includes(domain)) {
    return refuse('domain_not_allowed');
  }

  if (kind === 'microsoft') {
    if (claims.email_verified !== undefined && !isTrue(claims.email_verified)) return refuse('email_not_verified');
  } else if (!isTrue(claims.email_verified)) {
    return refuse('email_not_verified');
  }

  return { ok: true, subject, email, name: displayName(claims, email) };
}

/** A same-origin path to return to after sign-in; anything else (absolute URL, `//host`, control characters) becomes `/`. */
export function safeReturnTo(value: string | undefined): string {
  if (!value || value.length > 2048) return '/';
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}
