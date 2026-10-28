import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { Project, ProjectBranch, ProjectName, ProjectRepoUrl } from '../../entities/project.ts';
import { ChannelId, ProjectId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

// The projects routes. Everyone on the team reads; a team lead or a workspace admin writes.

export const ProjectsPathParams = z.object({ slug: TeamSlug });
export const ProjectItemPathParams = z.object({ slug: TeamSlug, projectId: ProjectId });

export const ListProjectsResponse = z.object({ items: z.array(Project) });
export type ListProjectsResponse = z.infer<typeof ListProjectsResponse>;
export const listProjectsRoute = { method: 'GET', path: '/api/teams/:slug/projects' } as const;

export const CreateProjectRequest = z.strictObject({
  name: ProjectName,
  repoUrl: ProjectRepoUrl,
  /** Omitted: `main`. */
  defaultBranch: ProjectBranch.optional(),
  channelId: ChannelId.nullable().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;
export const CreateProjectResponse = z.object({ project: Project });
export type CreateProjectResponse = z.infer<typeof CreateProjectResponse>;
export const createProjectRoute = { method: 'POST', path: '/api/teams/:slug/projects' } as const;

/** The name does not change: it is the repository's folder on the pod. Remove the project and add it again to rename it. */
export const UpdateProjectRequest = z.strictObject({
  repoUrl: ProjectRepoUrl.optional(),
  defaultBranch: ProjectBranch.optional(),
  channelId: ChannelId.nullable().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;
export const UpdateProjectResponse = z.object({ project: Project });
export type UpdateProjectResponse = z.infer<typeof UpdateProjectResponse>;
export const updateProjectRoute = { method: 'PATCH', path: '/api/teams/:slug/projects/:projectId' } as const;

export const DeleteProjectResponse = z.object({ deleted: z.literal(true) });
export type DeleteProjectResponse = z.infer<typeof DeleteProjectResponse>;
export const deleteProjectRoute = { method: 'DELETE', path: '/api/teams/:slug/projects/:projectId' } as const;

/**
 * A GitHub token the team's pod uses to push a tested branch and open a pull request (a fine-grained token with contents and pull request write
 * access to this one repository). Write-only: no response ever carries it.
 */
export const PushCredentialToken = z
  .string()
  .min(20)
  .max(255)
  .regex(/^[A-Za-z0-9_\-.]+$/, 'letters, digits, "_", "-" and "." only');
/** A GitHub login: letters, digits and single hyphens, up to 39 characters, not starting with a hyphen. */
export const GithubUsername = z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'a GitHub username: letters, digits and "-", up to 39 characters');
export const SetPushCredentialRequest = z.strictObject({ username: GithubUsername, token: PushCredentialToken });
export type SetPushCredentialRequest = z.infer<typeof SetPushCredentialRequest>;
export const SetPushCredentialResponse = z.object({ project: Project });
export type SetPushCredentialResponse = z.infer<typeof SetPushCredentialResponse>;
export const setPushCredentialRoute = { method: 'PUT', path: '/api/teams/:slug/projects/:projectId/push-credential' } as const;

export const RemovePushCredentialResponse = z.object({ project: Project });
export type RemovePushCredentialResponse = z.infer<typeof RemovePushCredentialResponse>;
/** Why a check of the token failed; each has its own plain message on the page. */
export const PushCredentialProblem = z.enum(['rejected', 'wrong_owner', 'no_write', 'unreachable']);
export type PushCredentialProblem = z.infer<typeof PushCredentialProblem>;
/** The result of asking GitHub about the stored token: who it belongs to and when it expires. */
export const TestPushCredentialResponse = z.object({ project: Project, ok: z.boolean(), login: z.string().nullable(), expiresAt: IsoDateTime.nullable(), message: z.string().nullable() });
export type TestPushCredentialResponse = z.infer<typeof TestPushCredentialResponse>;
export const testPushCredentialRoute = { method: 'POST', path: '/api/teams/:slug/projects/:projectId/push-credential/test' } as const;

export const removePushCredentialRoute = { method: 'DELETE', path: '/api/teams/:slug/projects/:projectId/push-credential' } as const;
