import { z } from 'zod';
import { AuthProviderId, PersonId, SessionId, WorkspaceId } from '../ids.ts';
import { OidcProviderKind } from '../api/auth/oidc.ts';

/** A person signed in through an OpenID Connect provider (audit). `createdPerson` is true on the first sign-in that made them. */
export const IdentityOidcSignedInEvent = z.object({
  type: z.literal('identity.oidc.signed_in'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  sessionId: SessionId,
  providerId: AuthProviderId,
  kind: OidcProviderKind,
  createdPerson: z.boolean(),
  ip: z.string().nullable(),
});
export type IdentityOidcSignedInEvent = z.infer<typeof IdentityOidcSignedInEvent>;
