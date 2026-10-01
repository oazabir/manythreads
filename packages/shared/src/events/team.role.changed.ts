import { z } from 'zod';
import { PersonId, TeamId, WorkspaceId } from '../ids.ts';
import { TeamRole } from '../entities/team.ts';

/** A team member's team role changed (lead or member). */
export const TeamRoleChangedEvent = z.object({
  type: z.literal('team.role.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  personId: PersonId,
  previousRole: TeamRole,
  role: TeamRole,
});
export type TeamRoleChangedEvent = z.infer<typeof TeamRoleChangedEvent>;
