import { z } from 'zod';
import { PersonId, TeamId, WorkspaceId } from '../ids.ts';
import { TeamRole } from '../entities/team.ts';

/** A person joined a team's roster. */
export const TeamMemberAddedEvent = z.object({
  type: z.literal('team.member.added'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  personId: PersonId,
  role: TeamRole,
});
export type TeamMemberAddedEvent = z.infer<typeof TeamMemberAddedEvent>;
