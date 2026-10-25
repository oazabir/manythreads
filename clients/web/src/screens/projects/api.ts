import {
  CreateProjectRequest,
  CreateProjectResponse,
  DeleteProjectResponse,
  ListProjectsResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  createProjectRoute,
  deleteProjectRoute,
  listProjectsRoute,
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
