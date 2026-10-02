import { z } from 'zod';
import { TeamId, WorkspaceId } from '../ids.ts';

/** A team was created (blank or from a template). Emitted by the actor who created it. */
export const WorkspaceTeamCreatedEvent = z.object({
  type: z.literal('workspace.team.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  slug: z.string(),
  name: z.string(),
  template: z.string().nullable(),
});
export type WorkspaceTeamCreatedEvent = z.infer<typeof WorkspaceTeamCreatedEvent>;
