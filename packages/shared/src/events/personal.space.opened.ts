import { z } from 'zod';
import { ActorId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * A workspace owner or admin opened one person's Personal space for reading (60 minutes, read-only by the database). The reason the admin gave is NOT
 * here: it lives in the access table, where only the admin and the person can read it, so the audit trail stays content-blind.
 */
export const PersonalSpaceOpenedEvent = z.object({
  type: z.literal('personal.space.opened'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** Whose space was opened. */
  personId: PersonId,
  adminActorId: ActorId,
  /** The `personal_space_access` row. */
  accessId: z.uuid(),
  validUntil: z.iso.datetime({ offset: true }),
});
export type PersonalSpaceOpenedEvent = z.infer<typeof PersonalSpaceOpenedEvent>;
