import { z } from 'zod';
import { Invitation, InvitationRole } from '../../entities/auth.ts';
import { TeamRole } from '../../entities/team.ts';
import { WorkspaceRole } from '../../entities/workspace.ts';
import { IsoDateTime } from '../../common/time.ts';
import { PersonId, TeamId, WorkspaceId } from '../../ids.ts';
import { GuestChannelGrant } from './common.ts';

const InviteeEmail = z.string().trim().toLowerCase().pipe(z.email());

/** Invite a person to a team (workspace role `member`). The token is shown once; only its hash is stored. */
export const InviteTeamMemberRequest = z.strictObject({ email: InviteeEmail, teamRole: TeamRole.default('member') });
export type InviteTeamMemberRequest = z.infer<typeof InviteTeamMemberRequest>;
export const CreateTeamInvitationResponse = z.object({ invitation: Invitation, token: z.string().min(20) });
export type CreateTeamInvitationResponse = z.infer<typeof CreateTeamInvitationResponse>;
export const createTeamInvitationRoute = { method: 'POST', path: '/api/teams/:slug/invitations' } as const;

export const ListTeamInvitationsResponse = z.object({ invitations: z.array(Invitation) });
export type ListTeamInvitationsResponse = z.infer<typeof ListTeamInvitationsResponse>;
export const listTeamInvitationsRoute = { method: 'GET', path: '/api/teams/:slug/invitations' } as const;

/**
 * A workspace-level invitation (admins only): `admin`, `member`, or a `guest` with the channels they will read.
 * A guest invitation carries no team; its channel grants are recorded in `grant.channels` and applied once the
 * channel exists.
 */
export const CreateInvitationRequest = z
  .strictObject({
    email: InviteeEmail,
    role: InvitationRole,
    channels: z.array(GuestChannelGrant).max(50).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.role === 'guest' && (v.channels?.length ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', path: ['channels'], message: 'a guest invitation names at least one channel' });
    }
    if (v.role !== 'guest' && v.channels !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['channels'], message: 'only a guest invitation carries channels' });
    }
  });
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;
export const CreateInvitationResponse = z.object({ invitation: Invitation, token: z.string().min(20) });
export type CreateInvitationResponse = z.infer<typeof CreateInvitationResponse>;
export const createInvitationRoute = { method: 'POST', path: '/api/invitations' } as const;

/** What the accept screen shows before the person accepts. Public: the token is the credential. */
export const GetInvitationResponse = z.object({
  workspaceName: z.string(),
  teamName: z.string().nullable(),
  email: z.string(),
  role: InvitationRole,
  invitedBy: z.string().nullable(),
  expiresAt: IsoDateTime,
});
export type GetInvitationResponse = z.infer<typeof GetInvitationResponse>;
export const getInvitationRoute = { method: 'GET', path: '/api/invitations/:token' } as const;

/** Accepting creates the person if the email is new and adds the workspace and team memberships; a used or expired token is 410. */
export const AcceptInvitationRequest = z.strictObject({ name: z.string().trim().min(1).max(120).optional() });
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequest>;
export const AcceptInvitationResponse = z.object({
  workspaceId: WorkspaceId,
  personId: PersonId,
  email: z.string(),
  workspaceRole: WorkspaceRole,
  teamId: TeamId.nullable(),
  teamRole: TeamRole.nullable(),
  createdPerson: z.boolean(),
});
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponse>;
export const acceptInvitationRoute = { method: 'POST', path: '/api/invitations/:token/accept' } as const;
