import { z } from 'zod';
import { TeamId, WorkspaceId } from '../ids.ts';

/** A team was archived (read-only until unarchived). */
export const WorkspaceTeamArchivedEvent = z.object({
  type: z.literal('workspace.team.archived'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
});
export type WorkspaceTeamArchivedEvent = z.infer<typeof WorkspaceTeamArchivedEvent>;
