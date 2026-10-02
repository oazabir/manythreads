import { z } from 'zod';
import { RoleId, TeamId, WorkspaceId } from '../ids.ts';

/** A team defined a role tag (`role:on-call`). */
export const TeamTagCreatedEvent = z.object({
  type: z.literal('team.tag.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  tag: z.string(),
  roleId: RoleId,
});
export type TeamTagCreatedEvent = z.infer<typeof TeamTagCreatedEvent>;
