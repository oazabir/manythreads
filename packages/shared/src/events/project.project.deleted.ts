import { z } from 'zod';
import { ProjectId, TeamId, WorkspaceId } from '../ids.ts';

/** A project was removed. */
export const ProjectDeletedEvent = z.object({
  type: z.literal('project.project.deleted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  projectId: ProjectId,
  name: z.string(),
});
export type ProjectDeletedEvent = z.infer<typeof ProjectDeletedEvent>;
