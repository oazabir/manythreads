import { Project, parseGithubRepo } from '@manythreads/shared';

// The one mapper of `app.projects` and the columns every query of the plugin selects.

export interface ProjectRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  channel_id: string | null;
  created_by: string | null;
  push_credential_set_at: Date | null;
  push_username: string | null;
  push_credential_expires_at: Date | null;
  push_credential_status: 'ok' | 'needs_replacing' | null;
  push_credential_shared: boolean;
  created_at: Date;
  updated_at: Date;
}

export const COLUMNS = 'id, workspace_id, team_id, name, repo_url, default_branch, channel_id, created_by, push_credential_set_at, push_username, push_credential_expires_at, push_credential_status, push_credential_shared, created_at, updated_at';

/** The one mapper of `app.projects`: a row to the shared type. */
export function toProject(r: ProjectRow): Project {
  return Project.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    name: r.name,
    repoUrl: r.repo_url,
    defaultBranch: r.default_branch,
    channelId: r.channel_id,
    createdBy: r.created_by,
    pushCredentialSetAt: r.push_credential_set_at ? r.push_credential_set_at.toISOString() : null,
    pushUsername: r.push_username,
    pushCredentialExpiresAt: r.push_credential_expires_at ? r.push_credential_expires_at.toISOString() : null,
    pushCredentialStatus: r.push_credential_status,
    pushCredentialShared: r.push_credential_shared,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });
}


/**
 * The owner a token can be shared under: `<host>/<owner>` in lower case, or null for an address that is not a GitHub repository (or whose host cannot be a
 * Secret key). Two projects share a token only when they have the same owner on the same host.
 */
export function ownerKeyOf(repoUrl: string): string | null {
  const g = parseGithubRepo(repoUrl);
  if (!g || !/^[a-z0-9][a-z0-9.-]*$/.test(g.host)) return null;
  return `${g.host}/${g.owner.toLowerCase()}`;
}

