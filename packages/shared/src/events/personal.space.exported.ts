import { z } from 'zod';
import { ActorId, PersonId, WorkspaceId } from '../ids.ts';

/** An admin downloaded a person's Personal space as a zip during a live open. Counts only: no file name, no path. */
export const PersonalSpaceExportedEvent = z.object({
  type: z.literal('personal.space.exported'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  adminActorId: ActorId,
  accessId: z.uuid(),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type PersonalSpaceExportedEvent = z.infer<typeof PersonalSpaceExportedEvent>;
