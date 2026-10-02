import { z } from 'zod';
import { WorkspaceRole } from '../entities/workspace.ts';
import { PersonId, WorkspaceId } from '../ids.ts';

/** A person's workspace role changed (audit). The workspace always keeps at least one owner. */
export const WorkspaceMemberRoleChangedEvent = z.object({
  type: z.literal('workspace.member.role_changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** Whose role changed. */
  personId: PersonId,
  previousRole: WorkspaceRole,
  role: WorkspaceRole,
  /** Who changed it. */
  changedBy: PersonId,
});
export type WorkspaceMemberRoleChangedEvent = z.infer<typeof WorkspaceMemberRoleChangedEvent>;
