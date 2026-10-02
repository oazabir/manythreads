import { z } from 'zod';
import { TeamRole } from '../../entities/team.ts';
import { WorkspaceRole } from '../../entities/workspace.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, PersonId } from '../../ids.ts';
import { RoleTagName } from './common.ts';

/** One person on a team's roster: their team role and the role tags they hold. */
export const RosterMember = z.object({
  personId: PersonId,
  actorId: ActorId,
  displayName: z.string(),
  email: z.string(),
  workspaceRole: WorkspaceRole,
  role: TeamRole,
  tags: z.array(RoleTagName),
  joinedAt: IsoDateTime,
});
export type RosterMember = z.infer<typeof RosterMember>;

export const GetTeamRosterResponse = z.object({ members: z.array(RosterMember) });
export type GetTeamRosterResponse = z.infer<typeof GetTeamRosterResponse>;
export const getTeamRosterRoute = { method: 'GET', path: '/api/teams/:slug/roster' } as const;

export const AddTeamMemberRequest = z.strictObject({ personId: PersonId, role: TeamRole.default('member') });
export type AddTeamMemberRequest = z.infer<typeof AddTeamMemberRequest>;
export const AddTeamMemberResponse = z.object({ member: RosterMember, added: z.boolean() });
export type AddTeamMemberResponse = z.infer<typeof AddTeamMemberResponse>;
export const addTeamMemberRoute = { method: 'POST', path: '/api/teams/:slug/members' } as const;

export const RemoveTeamMemberResponse = z.object({ removed: z.boolean(), tags: z.array(RoleTagName) });
export type RemoveTeamMemberResponse = z.infer<typeof RemoveTeamMemberResponse>;
export const removeTeamMemberRoute = { method: 'DELETE', path: '/api/teams/:slug/members/:personId' } as const;

export const SetTeamMemberRoleRequest = z.strictObject({ role: TeamRole });
export type SetTeamMemberRoleRequest = z.infer<typeof SetTeamMemberRoleRequest>;
export const SetTeamMemberRoleResponse = z.object({ member: RosterMember, changed: z.boolean() });
export type SetTeamMemberRoleResponse = z.infer<typeof SetTeamMemberRoleResponse>;
export const setTeamMemberRoleRoute = { method: 'PATCH', path: '/api/teams/:slug/members/:personId' } as const;
