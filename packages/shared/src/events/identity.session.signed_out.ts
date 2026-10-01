import { z } from 'zod';
import { PersonId, SessionId, WorkspaceId } from '../ids.ts';

/** One or more sessions of a person ended (audit). `sessionId` is set when exactly one session was targeted. */
export const IdentitySessionSignedOutEvent = z.object({
  type: z.literal('identity.session.signed_out'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  sessionId: SessionId.nullable(),
  scope: z.enum(['session', 'everywhere', 'other_session']),
  revoked: z.number().int().nonnegative(),
});
export type IdentitySessionSignedOutEvent = z.infer<typeof IdentitySessionSignedOutEvent>;
