import { z } from 'zod';
import { ChannelId, ProjectId, TeamId, WorkspaceId } from '../ids.ts';

/** A project's repository, branch or channel changed. */
export const ProjectUpdatedEvent = z.object({
  type: z.literal('project.project.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  projectId: ProjectId,
  name: z.string(),
  repoUrl: z.string(),
  defaultBranch: z.string(),
  channelId: ChannelId.nullable(),
});
export type ProjectUpdatedEvent = z.infer<typeof ProjectUpdatedEvent>;
