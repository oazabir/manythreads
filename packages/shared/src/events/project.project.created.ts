import { z } from 'zod';
import { ChannelId, ProjectId, TeamId, WorkspaceId } from '../ids.ts';

/** A team lead or admin added a project. */
export const ProjectCreatedEvent = z.object({
  type: z.literal('project.project.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  projectId: ProjectId,
  name: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  channelId: ChannelId.nullable(),
});
export type ProjectCreatedEvent = z.infer<typeof ProjectCreatedEvent>;
