import { z } from 'zod';
import { PersonId, TeamId, WorkspaceId } from '../ids.ts';

/** A team deleted a role tag; `removedFrom` lists the people who held it. */
export const TeamTagDeletedEvent = z.object({
  type: z.literal('team.tag.deleted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  tag: z.string(),
  removedFrom: z.array(PersonId),
});
export type TeamTagDeletedEvent = z.infer<typeof TeamTagDeletedEvent>;
