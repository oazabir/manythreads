import { z } from 'zod';
import { AuthProviderId, WorkspaceId } from '../ids.ts';
import { OidcProviderKind, OidcSignInErrorCode } from '../api/auth/oidc.ts';

/** An OpenID Connect sign-in was refused after the provider answered (audit). `email` is what the provider asserted, if anything. */
export const IdentityOidcRefusedEvent = z.object({
  type: z.literal('identity.oidc.refused'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  providerId: AuthProviderId,
  kind: OidcProviderKind,
  reason: OidcSignInErrorCode,
  email: z.string().nullable(),
  ip: z.string().nullable(),
});
export type IdentityOidcRefusedEvent = z.infer<typeof IdentityOidcRefusedEvent>;
