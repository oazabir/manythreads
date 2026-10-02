import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/** A verification link was used; `email` is the address now marked verified. */
export const IdentityEmailVerifiedEvent = z.object({
  type: z.literal('identity.email.verified'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  email: z.string().min(3),
});
export type IdentityEmailVerifiedEvent = z.infer<typeof IdentityEmailVerifiedEvent>;
