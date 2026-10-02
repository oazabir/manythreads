import { z } from 'zod';
import { PersonId, TeamId, WorkspaceId } from '../ids.ts';

/** A team member was given a role tag. */
export const TeamTagAssignedEvent = z.object({
  type: z.literal('team.tag.assigned'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  personId: PersonId,
  tag: z.string(),
});
export type TeamTagAssignedEvent = z.infer<typeof TeamTagAssignedEvent>;
