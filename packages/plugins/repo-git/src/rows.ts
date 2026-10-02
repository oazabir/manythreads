import { Repo, RepoCommit, RepoEntry } from '@manythreads/shared';

// The plugin's mappers for `repos`, `repo_entries` and `repo_commits`: the only place a row becomes a shared entity.

export type RepoRow = {
  team_id: string;
  path: string;
  head_sha: string | null;
  remote: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};
export const REPO_COLUMNS = 'r.team_id, r.path, r.head_sha, r.remote, r.created_at, r.updated_at';
export const toRepo = (r: RepoRow): Repo =>
  Repo.parse({
    teamId: r.team_id,
    path: r.path,
    headSha: r.head_sha,
    remote: r.remote,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  });

export type RepoEntryRow = {
  team_id: string;
  path: string;
  kind: string;
  blob_sha: string;
  size: string | number;
  last_commit_sha: string;
  text_plain: string | null;
};
export const REPO_ENTRY_COLUMNS = 'e.team_id, e.path, e.kind, e.blob_sha, e.size, e.last_commit_sha, e.text_plain';
export const toRepoEntry = (r: RepoEntryRow): RepoEntry =>
  RepoEntry.parse({
    teamId: r.team_id,
    path: r.path,
    kind: r.kind,
    blobSha: r.blob_sha,
    size: Number(r.size),
    lastCommitSha: r.last_commit_sha,
    textPlain: r.text_plain,
  });

export type RepoCommitRow = {
  team_id: string;
  sha: string;
  parent_sha: string | null;
  author_id: string | null;
  co_authors: string[];
  message: string;
  committed_at: Date;
  paths: string[];
};
export const REPO_COMMIT_COLUMNS = 'c.team_id, c.sha, c.parent_sha, c.author_id, c.co_authors, c.message, c.committed_at, c.paths';
export const toRepoCommit = (r: RepoCommitRow): RepoCommit =>
  RepoCommit.parse({
    teamId: r.team_id,
    sha: r.sha,
    parentSha: r.parent_sha,
    authorId: r.author_id,
    coAuthors: r.co_authors,
    message: r.message,
    committedAt: r.committed_at.toISOString(),
    paths: r.paths,
  });
