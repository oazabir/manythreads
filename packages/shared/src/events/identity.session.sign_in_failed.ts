import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/**
 * A sign-in for a KNOWN person did not succeed (audit). Attempts for an unknown email are not recorded as events
 * (there is no workspace to attach them to); they only count toward the in-memory lockout.
 */
export const IdentitySessionSignInFailedEvent = z.object({
  type: z.literal('identity.session.sign_in_failed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  method: z.literal('password'),
  reason: z.enum(['wrong_password', 'locked', 'suspended', 'method_disabled']),
  ip: z.string().nullable(),
});
export type IdentitySessionSignInFailedEvent = z.infer<typeof IdentitySessionSignInFailedEvent>;
