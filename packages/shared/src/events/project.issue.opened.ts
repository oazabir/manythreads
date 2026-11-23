import { z } from 'zod';
import { ActorId, ChannelId, MessageId, ProjectId, TeamId, WorkspaceId } from '../ids.ts';

/** An issue of a project's repository was given to the team's bots (P35-04): the platform posted it as a thread in the project's channel. No issue text. */
export const ProjectIssueOpenedEvent = z.object({
  type: z.literal('project.issue.opened'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  projectId: ProjectId,
  channelId: ChannelId,
  rootMessageId: MessageId,
  number: z.number().int().positive(),
  url: z.string().max(300),
  /** Who the bots work for on it: the person who connected the project (null when that person is gone). */
  askerActorId: ActorId.nullable(),
});
export type ProjectIssueOpenedEvent = z.infer<typeof ProjectIssueOpenedEvent>;
