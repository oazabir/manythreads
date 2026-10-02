import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { GitSha, RepoRef } from '../../entities/repo.ts';
import { ActorId } from '../../ids.ts';
import { CommitRepoResponse, RepoFilePath, RepoFolderPath } from './repo.ts';

// History, diff and restore of the team repo (SPEC section 5.1, PLAN P4-08). Reads need only team membership; a restore is a write like any other
// (the writer rules apply: guarded paths, text only). The rendered Markdown diff is made by the client from the two versions: read each with
// `GET /api/teams/:slug/repo/blob?path=&ref=<sha>`.

export const MAX_REPO_HISTORY_PAGE = 100;

export const GetRepoHistoryQuery = z.object({
  /** A file or a folder (every commit that touched anything below it); empty is the whole repo. */
  path: RepoFolderPath.default(''),
  limit: z.coerce.number().int().min(1).max(MAX_REPO_HISTORY_PAGE).default(30),
  /** `nextCursor` of the previous page. */
  cursor: GitSha.optional(),
});
export type GetRepoHistoryQuery = z.infer<typeof GetRepoHistoryQuery>;

export const RepoHistoryCommit = z.object({
  sha: GitSha,
  parentSha: GitSha.nullable(),
  /** The actor behind the author line; null for a commit the system made, or one made outside manythreads. */
  authorId: ActorId.nullable(),
  /** The name on the author line (a person's or bot's name at the time of the commit). */
  authorName: z.string(),
  coAuthorIds: z.array(ActorId),
  subject: z.string(),
  message: z.string(),
  committedAt: IsoDateTime,
  /** What the commit did to `path` when it names a file: added, modified, deleted. Null for the whole repo or a folder. */
  change: z.enum(['added', 'modified', 'deleted']).nullable(),
});
export type RepoHistoryCommit = z.infer<typeof RepoHistoryCommit>;

/** Newest first. */
export const GetRepoHistoryResponse = z.object({
  path: z.string(),
  commits: z.array(RepoHistoryCommit),
  nextCursor: GitSha.nullable(),
});
export type GetRepoHistoryResponse = z.infer<typeof GetRepoHistoryResponse>;
export const getRepoHistoryRoute = { method: 'GET', path: '/api/teams/:slug/repo/history' } as const;

export const GetRepoDiffQuery = z.object({
  path: RepoFilePath,
  /** The older side: a commit sha. Left out, the parent of `to` (an empty file when `to` is the first commit). */
  from: RepoRef.optional(),
  /** The newer side: `main`, `HEAD` or a commit sha (default `main`). */
  to: RepoRef.default('main'),
});
export type GetRepoDiffQuery = z.infer<typeof GetRepoDiffQuery>;

export const RepoDiffLine = z.object({
  type: z.enum(['context', 'add', 'del']),
  /** The line without its newline. */
  text: z.string(),
  /** The line number on each side; null on the side the line is not in. */
  oldLine: z.number().int().positive().nullable(),
  newLine: z.number().int().positive().nullable(),
});
export type RepoDiffLine = z.infer<typeof RepoDiffLine>;

/** One `@@ -oldStart,oldLines +newStart,newLines @@` block with three lines of context. */
export const RepoDiffHunk = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  header: z.string(),
  lines: z.array(RepoDiffLine),
});
export type RepoDiffHunk = z.infer<typeof RepoDiffHunk>;

/**
 * The change of one file between two commits, as unified hunks. `binary` is true for a file git does not diff as text (no hunks). `truncated` when the
 * patch was longer than the server's output cap (the hunks end early). `fromSha` is null when the file did not exist on the older side.
 */
export const GetRepoDiffResponse = z.object({
  path: z.string(),
  fromCommitSha: GitSha.nullable(),
  toCommitSha: GitSha,
  status: z.enum(['added', 'modified', 'deleted', 'unchanged']),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(RepoDiffHunk),
  truncated: z.boolean(),
});
export type GetRepoDiffResponse = z.infer<typeof GetRepoDiffResponse>;
export const getRepoDiffRoute = { method: 'GET', path: '/api/teams/:slug/repo/diff' } as const;

/** Put `path` back as it was at commit `sha` (the file is deleted if it did not exist there). The answer is a new commit; the old ones stay. */
export const RestoreRepoFileRequest = z.strictObject({
  path: RepoFilePath,
  sha: GitSha,
  /** The commit message; default `Restore <path> to <sha7>`. */
  message: z.string().trim().min(1).max(4000).optional(),
});
export type RestoreRepoFileRequest = z.infer<typeof RestoreRepoFileRequest>;
/** 201 with the new commit; 200 `noop: true` when the file already is as it was then. 403 for a guarded path (members), 404 for an unknown commit. */
export const RestoreRepoFileResponse = CommitRepoResponse.extend({ restoredFromSha: GitSha });
export type RestoreRepoFileResponse = z.infer<typeof RestoreRepoFileResponse>;
export const restoreRepoFileRoute = { method: 'POST', path: '/api/teams/:slug/repo/restore' } as const;

/**
 * The bytes of a repo file, for a URL (`<img src>`, `<video>`, a download link): `GET /api/teams/:slug/repo/content?path=&ref=`. `content-type` from the
 * extension (SVG is served as `image/svg+xml` under `default-src 'none'; sandbox` so it renders as an image and never runs); `x-content-type-options:
 * nosniff`; `cache-control: private, no-cache`; `?download=1` forces `attachment`. Same access as the blob route.
 */
export const GetRepoContentQuery = z.object({
  path: RepoFilePath,
  ref: RepoRef.default('main'),
  download: z.enum(['1', '0']).optional(),
});
export type GetRepoContentQuery = z.infer<typeof GetRepoContentQuery>;
export const getRepoContentRoute = { method: 'GET', path: '/api/teams/:slug/repo/content' } as const;
