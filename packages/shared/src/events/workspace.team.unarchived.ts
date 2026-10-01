import { z } from 'zod';
import { TeamId, WorkspaceId } from '../ids.ts';

/** An archived team was restored. */
export const WorkspaceTeamUnarchivedEvent = z.object({
  type: z.literal('workspace.team.unarchived'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
});
export type WorkspaceTeamUnarchivedEvent = z.infer<typeof WorkspaceTeamUnarchivedEvent>;
