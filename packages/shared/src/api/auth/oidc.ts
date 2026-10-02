import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { AuthProviderId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// OpenID Connect sign-in (SPEC §4): Google Workspace and Microsoft 365 presets plus any OIDC provider. Everything the
// admin API accepts or returns is here. A client secret goes in on create/update and never comes back: responses only
// say `hasSecret`.

export const OidcProviderKind = z.enum(['google', 'microsoft', 'oidc']);
export type OidcProviderKind = z.infer<typeof OidcProviderKind>;

/** The Google preset's fixed issuer; the Microsoft preset's is derived from the tenant id. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const microsoftIssuer = (tenantId: string): string => `https://login.microsoftonline.com/${tenantId}/v2.0`;

const Label = z.string().trim().min(1).max(80);
const ClientId = z.string().trim().min(1).max(512);
const ClientSecret = z.string().min(1, 'Enter the client secret.').max(4096);

/** A bare domain such as `kahf.co`, lower-cased. */
export const EmailDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a domain such as kahf.co.');
export type EmailDomain = z.infer<typeof EmailDomain>;

const AllowedDomains = z.array(EmailDomain).max(50);

export const TenantId = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Enter the tenant id (a GUID).');

/** https, or http only for a loopback host (the dev mock issuer). */
const IssuerUrl = z
  .url()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      if (u.protocol === 'https:') return true;
      return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    } catch {
      return false;
    }
  }, 'The issuer URL must use https.');

/** Create a provider. Discovery runs on save; a failure leaves it disabled with the reason. */
export const CreateOidcProviderRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('google'),
    label: Label.optional(),
    clientId: ClientId,
    clientSecret: ClientSecret,
    /** Required: the domain allowlist is the workspace boundary. Checked against the email and the `hd` claim. */
    allowedDomains: AllowedDomains.min(1, 'Add at least one allowed domain.'),
    enabled: z.boolean().default(true),
  }),
  z.strictObject({
    kind: z.literal('microsoft'),
    label: Label.optional(),
    tenantId: TenantId,
    clientId: ClientId,
    clientSecret: ClientSecret,
    allowedDomains: AllowedDomains.default([]),
    enabled: z.boolean().default(true),
  }),
  z.strictObject({
    kind: z.literal('oidc'),
    label: Label.optional(),
    issuer: IssuerUrl,
    clientId: ClientId,
    clientSecret: ClientSecret,
    allowedDomains: AllowedDomains.default([]),
    enabled: z.boolean().default(true),
  }),
]);
export type CreateOidcProviderRequest = z.infer<typeof CreateOidcProviderRequest>;

/** Change a provider. The kind never changes; `clientSecret` is optional (omit to keep the stored one). */
export const UpdateOidcProviderRequest = z.strictObject({
  label: Label.optional(),
  clientId: ClientId.optional(),
  clientSecret: ClientSecret.optional(),
  allowedDomains: AllowedDomains.optional(),
  /** Microsoft only. */
  tenantId: TenantId.optional(),
  /** Any-OIDC only. */
  issuer: IssuerUrl.optional(),
});
export type UpdateOidcProviderRequest = z.infer<typeof UpdateOidcProviderRequest>;

/** Outcome of the last discovery check, shown to the admin (never contains a secret). */
export const OidcTestResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  checkedAt: IsoDateTime,
});
export type OidcTestResult = z.infer<typeof OidcTestResult>;

export const OidcProvider = z.object({
  id: AuthProviderId,
  kind: OidcProviderKind,
  label: z.string(),
  clientId: z.string(),
  issuer: z.string(),
  /** Microsoft only. */
  tenantId: z.string().nullable(),
  allowedDomains: z.array(z.string()),
  enabled: z.boolean(),
  /** Why the provider is disabled (e.g. discovery failed); null when it is enabled or was switched off by hand. */
  disabledReason: z.string().nullable(),
  /** Always a boolean: the secret itself is never returned. */
  hasSecret: z.boolean(),
  /** The redirect URI to register with the identity provider. */
  callbackUrl: z.string(),
  lastTest: OidcTestResult.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OidcProvider = z.infer<typeof OidcProvider>;

export const OidcProviderResponse = z.object({ provider: OidcProvider });
export type OidcProviderResponse = z.infer<typeof OidcProviderResponse>;

export const ListOidcProvidersResponse = z.object({ providers: z.array(OidcProvider) });
export type ListOidcProvidersResponse = z.infer<typeof ListOidcProvidersResponse>;

export const TestOidcProviderResponse = z.object({ result: OidcTestResult, provider: OidcProvider });
export type TestOidcProviderResponse = z.infer<typeof TestOidcProviderResponse>;

export const DeleteOidcProviderResponse = z.object({ ok: z.literal(true) });
export type DeleteOidcProviderResponse = z.infer<typeof DeleteOidcProviderResponse>;

export const listOidcProvidersRoute = { method: 'GET', path: '/api/auth/oidc/providers' } as const satisfies ApiRoute;
export const createOidcProviderRoute = { method: 'POST', path: '/api/auth/oidc/providers' } as const satisfies ApiRoute;
export const updateOidcProviderRoute = {
  method: 'PATCH',
  path: '/api/auth/oidc/providers/:providerId',
} as const satisfies ApiRoute;
export const deleteOidcProviderRoute = {
  method: 'DELETE',
  path: '/api/auth/oidc/providers/:providerId',
} as const satisfies ApiRoute;
export const testOidcProviderRoute = {
  method: 'POST',
  path: '/api/auth/oidc/providers/:providerId/test',
} as const satisfies ApiRoute;
export const enableOidcProviderRoute = {
  method: 'POST',
  path: '/api/auth/oidc/providers/:providerId/enable',
} as const satisfies ApiRoute;
export const disableOidcProviderRoute = {
  method: 'POST',
  path: '/api/auth/oidc/providers/:providerId/disable',
} as const satisfies ApiRoute;

/** A sign-in button: the enabled providers of the workspace, public. Navigate (not fetch) to `startUrl`. */
export const OidcSignInMethod = z.object({
  id: AuthProviderId,
  kind: OidcProviderKind,
  label: z.string(),
  startUrl: z.string(),
});
export type OidcSignInMethod = z.infer<typeof OidcSignInMethod>;

export const ListOidcMethodsQuery = z.object({ workspace: z.string().min(1).max(63).optional() });
export type ListOidcMethodsQuery = z.infer<typeof ListOidcMethodsQuery>;
export const ListOidcMethodsResponse = z.object({ methods: z.array(OidcSignInMethod) });
export type ListOidcMethodsResponse = z.infer<typeof ListOidcMethodsResponse>;
export const listOidcMethodsRoute = { method: 'GET', path: '/api/auth/oidc/methods' } as const satisfies ApiRoute;

/** `GET /api/auth/oidc/:providerId/start?returnTo=/path`: answers 302 to the identity provider. */
export const OidcStartQuery = z.object({ returnTo: z.string().max(2048).optional() });
export type OidcStartQuery = z.infer<typeof OidcStartQuery>;
export const oidcStartRoute = { method: 'GET', path: '/api/auth/oidc/:providerId/start' } as const satisfies ApiRoute;
/** `GET /api/auth/oidc/callback`: answers 302 to the return path (signed in) or to `/sign-in?error=<code>`. */
export const oidcCallbackRoute = { method: 'GET', path: '/api/auth/oidc/callback' } as const satisfies ApiRoute;

/** Why a sign-in was refused; the code travels as `/sign-in?error=<code>`. */
export const OidcSignInErrorCode = z.enum([
  'domain_not_allowed',
  'tenant_not_allowed',
  'email_not_verified',
  'account_unverified',
  'identity_mismatch',
  'signup_closed',
  'account_suspended',
  'provider_disabled',
  'state_invalid',
  'token_invalid',
  'access_denied',
  'sign_in_failed',
]);
export type OidcSignInErrorCode = z.infer<typeof OidcSignInErrorCode>;

/** What the sign-in screen shows for each code. */
export const OIDC_SIGN_IN_ERROR_MESSAGES: Record<OidcSignInErrorCode, string> = {
  domain_not_allowed: 'That domain is not allowed.',
  tenant_not_allowed: 'That Microsoft account belongs to a different organization.',
  email_not_verified: 'Your email address is not verified with that provider.',
  account_unverified: 'Verify your email address first, then sign in with this method.',
  identity_mismatch: 'This account is already linked to a different login at that provider.',
  signup_closed: 'You need an invitation to join this workspace.',
  account_suspended: 'This account has been suspended.',
  provider_disabled: 'That sign-in method is turned off.',
  state_invalid: 'The sign-in link expired. Try again.',
  token_invalid: 'The provider sent a response we could not trust. Try again.',
  access_denied: 'The provider did not let you in.',
  sign_in_failed: 'Sign-in failed. Try again.',
};
