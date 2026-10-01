import { z } from 'zod';
import { TeamId, WorkspaceId } from '../ids.ts';

/** A team was renamed; the slug never changes. */
export const WorkspaceTeamRenamedEvent = z.object({
  type: z.literal('workspace.team.renamed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  previousName: z.string(),
  name: z.string(),
});
export type WorkspaceTeamRenamedEvent = z.infer<typeof WorkspaceTeamRenamedEvent>;
