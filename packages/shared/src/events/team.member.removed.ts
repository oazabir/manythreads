import { z } from 'zod';
import { PersonId, TeamId, WorkspaceId } from '../ids.ts';
import { TeamRole } from '../entities/team.ts';

/** A person left or was removed from a team; `tags` are the team's role tags they lost with the seat. */
export const TeamMemberRemovedEvent = z.object({
  type: z.literal('team.member.removed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  personId: PersonId,
  role: TeamRole,
  tags: z.array(z.string()),
});
export type TeamMemberRemovedEvent = z.infer<typeof TeamMemberRemovedEvent>;
