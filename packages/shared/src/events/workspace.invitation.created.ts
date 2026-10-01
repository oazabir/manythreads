import { z } from 'zod';
import { InvitationId, TeamId, WorkspaceId } from '../ids.ts';
import { InvitationRole } from '../entities/auth.ts';
import { TeamRole } from '../entities/team.ts';

/** An invitation was created. The token is never part of an event; `teamId` is null for workspace-level and guest invitations. */
export const WorkspaceInvitationCreatedEvent = z.object({
  type: z.literal('workspace.invitation.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  invitationId: InvitationId,
  email: z.string(),
  role: InvitationRole,
  teamRole: TeamRole.nullable(),
});
export type WorkspaceInvitationCreatedEvent = z.infer<typeof WorkspaceInvitationCreatedEvent>;
