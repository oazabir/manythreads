import { z } from 'zod';
import { PersonId, SessionId, WorkspaceId } from '../ids.ts';

/** A person signed in (audit). `method` is how: password form, the one-time bootstrap link or a password reset. */
export const IdentitySessionSignedInEvent = z.object({
  type: z.literal('identity.session.signed_in'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  sessionId: SessionId,
  method: z.enum(['password', 'bootstrap']),
  ip: z.string().nullable(),
});
export type IdentitySessionSignedInEvent = z.infer<typeof IdentitySessionSignedInEvent>;
