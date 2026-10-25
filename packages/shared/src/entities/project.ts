import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { isPlainRepoUrl } from './repo-origin.ts';
import { ActorId, ChannelId, ProjectId, TeamId, WorkspaceId } from '../ids.ts';

// A project is a git repository a team works on, tied to one of the team's channels. The checks here match the CHECKs of the projects
// plugin migrations 0001_projects.sql and 0002_repo_url_plain.sql.

/** The project's name: it is also the folder name of its repository on the team's Hermes pod, so it follows the same rule. */
export const ProjectName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,60}$/, 'lowercase letters, digits, ".", "_" or "-"')
  .refine((v) => !v.includes('..'), 'no ".." in the name');
export type ProjectName = z.infer<typeof ProjectName>;

/**
 * An https address of a git repository: no user name or password, no query, no fragment, no "@" anywhere, no empty or dot path segments
 * ("//", ".", "..", "%2e"). Refused, never normalised. Same rule as `isPlainRepoUrl` and the CHECK of migration 0002_repo_url_plain.sql.
 */
export const ProjectRepoUrl = z
  .string()
  .max(300)
  .refine(isPlainRepoUrl, 'an https address with no credentials, query, fragment, "@", or empty or dot path segments');
export type ProjectRepoUrl = z.infer<typeof ProjectRepoUrl>;

/** A branch name, in the plain subset of git's rules. */
export const ProjectBranch = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/, 'letters, digits, ".", "_", "-" or "/"')
  .refine((v) => !v.includes('..') && !v.endsWith('/') && !v.endsWith('.lock'), 'not a valid branch name');
export type ProjectBranch = z.infer<typeof ProjectBranch>;

export const Project = z.object({
  id: ProjectId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  name: ProjectName,
  repoUrl: ProjectRepoUrl,
  defaultBranch: ProjectBranch,
  /** The team channel this project is worked on in; null until one is chosen. At most one project per channel. */
  channelId: ChannelId.nullable(),
  createdBy: ActorId.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Project = z.infer<typeof Project>;
