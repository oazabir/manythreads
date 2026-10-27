import {
  CreateProjectRequest,
  CreateProjectResponse,
  DeleteProjectResponse,
  ListProjectsResponse,
  RemovePushCredentialResponse,
  SetPushCredentialRequest,
  SetPushCredentialResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  createProjectRoute,
  deleteProjectRoute,
  listProjectsRoute,
  removePushCredentialRoute,
  setPushCredentialRoute,
  updateProjectRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';

/* What the Projects page asks of the server: a team's projects (list, add, change, remove). */

export const fetchProjects = (slug: string) => call(listProjectsRoute, { response: ListProjectsResponse }, undefined, { slug });

export const createProject = (slug: string, body: CreateProjectRequest) =>
  call(createProjectRoute, { request: CreateProjectRequest, response: CreateProjectResponse }, body, { slug });

export const updateProject = (slug: string, projectId: string, body: UpdateProjectRequest) =>
  call(updateProjectRoute, { request: UpdateProjectRequest, response: UpdateProjectResponse }, body, { slug, projectId });

export const deleteProject = (slug: string, projectId: string) =>
  call(deleteProjectRoute, { response: DeleteProjectResponse }, undefined, { slug, projectId });

/* The GitHub token the team pod publishes with: written, never read back (the project only says whether one is set). */
export const setPushCredential = (slug: string, projectId: string, token: string) =>
  call(setPushCredentialRoute, { request: SetPushCredentialRequest, response: SetPushCredentialResponse }, { token }, { slug, projectId });

export const removePushCredential = (slug: string, projectId: string) =>
  call(removePushCredentialRoute, { response: RemovePushCredentialResponse }, undefined, { slug, projectId });
