import { z } from 'zod';
import { PersonId, TeamId, WorkspaceId } from '../ids.ts';

/** A team member lost a role tag. */
export const TeamTagRemovedEvent = z.object({
  type: z.literal('team.tag.removed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  personId: PersonId,
  tag: z.string(),
});
export type TeamTagRemovedEvent = z.infer<typeof TeamTagRemovedEvent>;
