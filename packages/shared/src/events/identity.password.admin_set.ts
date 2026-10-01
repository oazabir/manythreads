import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/** An operator set a person's password from the server's admin CLI (every session of theirs was signed out). */
export const IdentityPasswordAdminSetEvent = z.object({
  type: z.literal('identity.password.admin_set'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  /** How many live sessions the change signed out. */
  sessionsRevoked: z.number().int().nonnegative(),
});
export type IdentityPasswordAdminSetEvent = z.infer<typeof IdentityPasswordAdminSetEvent>;
