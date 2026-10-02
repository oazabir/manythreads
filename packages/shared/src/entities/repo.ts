import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, TeamId } from '../ids.ts';
import { JsonObject } from './kernel.ts';

// PLAN.md A.4 `repos`, `repo_entries`, `repo_commits`. Matches plugins/repo-git/migrations. The index mirrors git (git is the truth):
// it exists for search, listings and history queries, and is rebuilt from git when it falls behind.

/** A full git object id (SHA-1, 40 lowercase hex). */
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character git sha');
export type GitSha = z.infer<typeof GitSha>;

/** What a read may name: the branch, `HEAD`, or a commit sha (7 to 40 hex). No other ref reaches git. */
export const RepoRef = z.string().regex(/^(HEAD|main|[0-9a-f]{7,40})$/, 'main, HEAD or a commit sha');
export type RepoRef = z.infer<typeof RepoRef>;

/** One repo per team. `path` is relative to `MANYTHREADS_REPO_DIR` (`<team id>.git`); `headSha` is null until the first commit. */
export const Repo = z.object({
  teamId: TeamId,
  path: z.string().min(1),
  headSha: GitSha.nullable(),
  /** Where the team pushes its repo (GitHub, GitLab), later; never holds a credential. */
  remote: JsonObject.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Repo = z.infer<typeof Repo>;

/** A file of the current tree. `textPlain` holds the text of a UTF-8 file up to 1 MB (page and file search); null for anything else. */
export const RepoEntry = z.object({
  teamId: TeamId,
  path: z.string().min(1),
  kind: z.enum(['file']),
  blobSha: GitSha,
  size: z.number().int().nonnegative(),
  lastCommitSha: GitSha,
  textPlain: z.string().nullable(),
});
export type RepoEntry = z.infer<typeof RepoEntry>;

/** A commit in the History index. `authorId` is null for a commit the system made (the first commit of a team). */
export const RepoCommit = z.object({
  teamId: TeamId,
  sha: GitSha,
  parentSha: GitSha.nullable(),
  authorId: ActorId.nullable(),
  coAuthors: z.array(ActorId),
  message: z.string(),
  committedAt: IsoDateTime,
  paths: z.array(z.string()),
});
export type RepoCommit = z.infer<typeof RepoCommit>;
