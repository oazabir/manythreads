import { z } from 'zod';
import { AuthProviderKind } from '../entities/auth.ts';
import { AuthProviderId, PersonId, WorkspaceId } from '../ids.ts';

/** An admin changed a sign-in provider (audit). Carries no secret and no client id. */
export const IdentityProviderChangedEvent = z.object({
  type: z.literal('identity.provider.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  providerId: AuthProviderId,
  kind: AuthProviderKind,
  change: z.enum(['created', 'updated', 'enabled', 'disabled', 'deleted', 'tested']),
  /** Whether the provider is enabled after the change. */
  enabled: z.boolean(),
  /** The admin who made the change; null when it was not a person. */
  personId: PersonId.nullable(),
});
export type IdentityProviderChangedEvent = z.infer<typeof IdentityProviderChangedEvent>;
