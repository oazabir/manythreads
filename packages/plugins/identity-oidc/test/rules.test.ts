import { describe, expect, it } from 'vitest';
import { evaluateClaims, safeReturnTo, type IdClaims } from '../src/rules.ts';

const TENANT = '9f1c7a64-2b2a-4c0e-8f3c-5a6f1e0c2d11';
const google = (claims: IdClaims, allowedDomains = ['kahf.co']) =>
  evaluateClaims({ kind: 'google', tenantId: null, allowedDomains, claims });
const microsoft = (claims: IdClaims, allowedDomains: string[] = []) =>
  evaluateClaims({ kind: 'microsoft', tenantId: TENANT, allowedDomains, claims });
const oidc = (claims: IdClaims, allowedDomains: string[] = []) =>
  evaluateClaims({ kind: 'oidc', tenantId: null, allowedDomains, claims });

describe('Google preset', () => {
  it('accepts a verified address whose domain and hd are allowed', () => {
    const out = google({ sub: 's1', email: 'Tariq@Kahf.co', email_verified: true, hd: 'kahf.co', name: 'Tariq' });
    expect(out).toEqual({ ok: true, subject: 's1', email: 'tariq@kahf.co', name: 'Tariq' });
  });
  it('refuses another domain', () => {
    expect(google({ sub: 's', email: 'x@other.com', email_verified: true, hd: 'other.com' })).toMatchObject({
      ok: false,
      reason: 'domain_not_allowed',
      email: 'x@other.com',
    });
  });
  it('refuses a personal account (no hd) and an hd that is not allowed', () => {
    expect(google({ sub: 's', email: 'x@kahf.co', email_verified: true })).toMatchObject({ reason: 'domain_not_allowed' });
    expect(google({ sub: 's', email: 'x@kahf.co', email_verified: true, hd: 'other.com' })).toMatchObject({ reason: 'domain_not_allowed' });
  });
  it('refuses an unverified address', () => {
    expect(google({ sub: 's', email: 'x@kahf.co', email_verified: false, hd: 'kahf.co' })).toMatchObject({ reason: 'email_not_verified' });
  });
  it('never allows anyone when no domain is configured', () => {
    expect(google({ sub: 's', email: 'x@kahf.co', email_verified: true, hd: 'kahf.co' }, [])).toMatchObject({ reason: 'domain_not_allowed' });
  });
  it('does not match a subdomain or a look-alike suffix', () => {
    expect(google({ sub: 's', email: 'x@evilkahf.co', email_verified: true, hd: 'evilkahf.co' })).toMatchObject({ reason: 'domain_not_allowed' });
    expect(google({ sub: 's', email: 'x@a.kahf.co', email_verified: true, hd: 'a.kahf.co' })).toMatchObject({ reason: 'domain_not_allowed' });
  });
});

describe('Microsoft preset', () => {
  it('accepts the configured tenant, reading the UPN when there is no email claim', () => {
    expect(microsoft({ sub: 'm', tid: TENANT, preferred_username: 'Nadia@kahf.co' })).toMatchObject({ ok: true, email: 'nadia@kahf.co' });
  });
  it('refuses another tenant before looking at anything else', () => {
    expect(microsoft({ sub: 'm', tid: '11111111-2222-4333-8444-555555555555', email: 'nadia@kahf.co' })).toMatchObject({
      reason: 'tenant_not_allowed',
    });
    expect(microsoft({ sub: 'm', email: 'nadia@kahf.co' })).toMatchObject({ reason: 'tenant_not_allowed' });
  });
  it('applies the domain list inside the tenant and refuses an explicit email_verified false', () => {
    expect(microsoft({ sub: 'm', tid: TENANT, email: 'a@other.com' }, ['kahf.co'])).toMatchObject({ reason: 'domain_not_allowed' });
    expect(microsoft({ sub: 'm', tid: TENANT, email: 'a@kahf.co', email_verified: false })).toMatchObject({ reason: 'email_not_verified' });
  });
});

describe('any OIDC provider', () => {
  it('needs a verified email and honours the optional domain list', () => {
    expect(oidc({ sub: 'o', email: 'a@x.org', email_verified: true })).toMatchObject({ ok: true });
    expect(oidc({ sub: 'o', email: 'a@x.org', email_verified: 'true' })).toMatchObject({ ok: true });
    expect(oidc({ sub: 'o', email: 'a@x.org' })).toMatchObject({ reason: 'email_not_verified' });
    expect(oidc({ sub: 'o', email: 'a@x.org', email_verified: true }, ['kahf.co'])).toMatchObject({ reason: 'domain_not_allowed' });
    expect(oidc({ email: 'a@x.org', email_verified: true })).toMatchObject({ reason: 'token_invalid' });
    expect(oidc({ sub: 'o', email_verified: true })).toMatchObject({ reason: 'email_not_verified' });
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/teams/engineering?tab=roster', '/teams/engineering?tab=roster'],
    ['/', '/'],
    [undefined, '/'],
    ['', '/'],
    ['https://evil.example/', '/'],
    ['//evil.example/', '/'],
    ['/\\evil.example', '/'],
    ['teams', '/'],
    ['/a\nb', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});
