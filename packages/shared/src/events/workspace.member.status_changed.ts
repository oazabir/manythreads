import { z } from 'zod';
import { PersonStatus } from '../entities/person.ts';
import { PersonId, WorkspaceId } from '../ids.ts';

/**
 * A member was deactivated (`suspended`) or reactivated (`active`) by an admin. A deactivated person cannot sign in and every session of theirs ends.
 * The 30-day clock after which their Personal space is deleted starts when they are deactivated (and stops if they are reactivated).
 */
export const WorkspaceMemberStatusChangedEvent = z.object({
  type: z.literal('workspace.member.status_changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  previousStatus: PersonStatus,
  status: PersonStatus,
  changedBy: PersonId,
});
export type WorkspaceMemberStatusChangedEvent = z.infer<typeof WorkspaceMemberStatusChangedEvent>;
