import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/** A person set a new password through a reset link (every session of theirs was signed out). */
export const IdentityPasswordResetEvent = z.object({
  type: z.literal('identity.password.reset'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
});
export type IdentityPasswordResetEvent = z.infer<typeof IdentityPasswordResetEvent>;
