import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';

/** A signed-in person changed their own password. Their other sessions ended and outstanding reset links were spent. */
export const IdentityPasswordChangedEvent = z.object({
  type: z.literal('identity.password.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  /** How many other sessions were signed out. */
  revokedSessions: z.number().int().nonnegative(),
});
export type IdentityPasswordChangedEvent = z.infer<typeof IdentityPasswordChangedEvent>;
