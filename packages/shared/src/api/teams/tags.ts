import { z } from 'zod';
import { PersonId, RoleId } from '../../ids.ts';
import { RoleTagName } from './common.ts';

/** A role tag a team defines (`role:on-call`) and the team members who hold it. */
export const TeamTag = z.object({ name: RoleTagName, roleId: RoleId, holders: z.array(PersonId) });
export type TeamTag = z.infer<typeof TeamTag>;

export const ListTeamTagsResponse = z.object({ tags: z.array(TeamTag) });
export type ListTeamTagsResponse = z.infer<typeof ListTeamTagsResponse>;
export const listTeamTagsRoute = { method: 'GET', path: '/api/teams/:slug/tags' } as const;

export const CreateTeamTagRequest = z.strictObject({ name: RoleTagName });
export type CreateTeamTagRequest = z.infer<typeof CreateTeamTagRequest>;
export const CreateTeamTagResponse = z.object({ tag: TeamTag, created: z.boolean() });
export type CreateTeamTagResponse = z.infer<typeof CreateTeamTagResponse>;
export const createTeamTagRoute = { method: 'POST', path: '/api/teams/:slug/tags' } as const;

/** Deleting a tag takes it away from every holder on the team. */
export const DeleteTeamTagResponse = z.object({ deleted: z.boolean(), removedFrom: z.array(PersonId) });
export type DeleteTeamTagResponse = z.infer<typeof DeleteTeamTagResponse>;
export const deleteTeamTagRoute = { method: 'DELETE', path: '/api/teams/:slug/tags/:tag' } as const;

/** Giving a tag nobody has defined yet defines it for the team first. */
export const AssignTeamTagResponse = z.object({ tag: TeamTag, assigned: z.boolean() });
export type AssignTeamTagResponse = z.infer<typeof AssignTeamTagResponse>;
export const assignTeamTagRoute = { method: 'PUT', path: '/api/teams/:slug/members/:personId/tags/:tag' } as const;

export const UnassignTeamTagResponse = z.object({ removed: z.boolean() });
export type UnassignTeamTagResponse = z.infer<typeof UnassignTeamTagResponse>;
export const unassignTeamTagRoute = { method: 'DELETE', path: '/api/teams/:slug/members/:personId/tags/:tag' } as const;
