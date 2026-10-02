import { z } from 'zod';
import { TeamTemplate } from '../../entities/template.ts';
import { TeamSlug, TeamDetail, TeamSummary } from './common.ts';

const TeamName = z.string().trim().min(1).max(80);

export const ListTeamsQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() });
export type ListTeamsQuery = z.infer<typeof ListTeamsQuery>;
export const ListTeamsResponse = z.object({ teams: z.array(TeamSummary) });
export type ListTeamsResponse = z.infer<typeof ListTeamsResponse>;
export const listTeamsRoute = { method: 'GET', path: '/api/teams' } as const;

export const GetTeamResponse = z.object({ team: TeamDetail });
export type GetTeamResponse = z.infer<typeof GetTeamResponse>;
export const getTeamRoute = { method: 'GET', path: '/api/teams/:slug' } as const;

/** A blank team; the slug defaults to the name in lowercase with dashes. */
export const CreateTeamRequest = z.strictObject({ name: TeamName, slug: TeamSlug.optional() });
export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>;
export const CreateTeamResponse = z.object({ team: TeamDetail });
export type CreateTeamResponse = z.infer<typeof CreateTeamResponse>;
export const createTeamRoute = { method: 'POST', path: '/api/teams' } as const;

/** Apply a team template. Applying the same template for the same slug again returns the existing team (200, `created: false`). */
export const ApplyTeamTemplateRequest = z.strictObject({
  templateId: TeamTemplate.shape.id,
  name: TeamName.optional(),
  slug: TeamSlug.optional(),
});
export type ApplyTeamTemplateRequest = z.infer<typeof ApplyTeamTemplateRequest>;
export const ApplyTeamTemplateResponse = z.object({ team: TeamDetail, created: z.boolean() });
export type ApplyTeamTemplateResponse = z.infer<typeof ApplyTeamTemplateResponse>;
export const applyTeamTemplateRoute = { method: 'POST', path: '/api/teams/from-template' } as const;

export const RenameTeamRequest = z.strictObject({ name: TeamName });
export type RenameTeamRequest = z.infer<typeof RenameTeamRequest>;
export const RenameTeamResponse = z.object({ team: TeamDetail });
export type RenameTeamResponse = z.infer<typeof RenameTeamResponse>;
export const renameTeamRoute = { method: 'PATCH', path: '/api/teams/:slug' } as const;

export const ArchiveTeamResponse = z.object({ team: TeamDetail, changed: z.boolean() });
export type ArchiveTeamResponse = z.infer<typeof ArchiveTeamResponse>;
export const archiveTeamRoute = { method: 'POST', path: '/api/teams/:slug/archive' } as const;

export const UnarchiveTeamResponse = z.object({ team: TeamDetail, changed: z.boolean() });
export type UnarchiveTeamResponse = z.infer<typeof UnarchiveTeamResponse>;
export const unarchiveTeamRoute = { method: 'POST', path: '/api/teams/:slug/unarchive' } as const;
