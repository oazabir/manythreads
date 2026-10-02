import { z } from 'zod';
import { InvitationId, PersonId, TeamId, WorkspaceId } from '../ids.ts';
import { InvitationRole } from '../entities/auth.ts';
import { TeamRole } from '../entities/team.ts';

/** An invitation was accepted: the person (new or existing) now holds the workspace role and, for a team invitation, the team seat. */
export const WorkspaceInvitationAcceptedEvent = z.object({
  type: z.literal('workspace.invitation.accepted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  invitationId: InvitationId,
  personId: PersonId,
  role: InvitationRole,
  teamRole: TeamRole.nullable(),
  createdPerson: z.boolean(),
});
export type WorkspaceInvitationAcceptedEvent = z.infer<typeof WorkspaceInvitationAcceptedEvent>;
