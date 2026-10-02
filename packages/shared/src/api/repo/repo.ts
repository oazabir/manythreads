import { z } from 'zod';
import { GitSha, RepoRef } from '../../entities/repo.ts';
import { REPO_BRANCH, REPO_MAX_FILE_BYTES, parseRepoPath } from '../../entities/repo-paths.ts';
import { ActorId } from '../../ids.ts';

// The team repo over HTTP (SPEC section 5.1; PLAN P4-01..P4-05). Paths are relative to the repo root. Writes are one commit with the
// signed-in person as author; the routes of the Files tree, history and restore build on these.

export const RepoPathParams = z.object({ slug: z.string().min(1).max(63) });
export type RepoPathParams = z.infer<typeof RepoPathParams>;

/** A path the caller names: strict (no `..`, no leading `/`, no `.git` segment), NFC-normalised. Empty is allowed for a folder query (the root). */
export const RepoFolderPath = z
  .string()
  .max(1024)
  .transform((value, ctx) => {
    if (value === '' || value === '/') return '';
    const parsed = parseRepoPath(value.replace(/\/+$/, ''));
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.reason });
      return z.NEVER;
    }
    return parsed.path;
  });
export const RepoFilePath = z
  .string()
  .min(1)
  .max(1024)
  .transform((value, ctx) => {
    const parsed = parseRepoPath(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.reason });
      return z.NEVER;
    }
    return parsed.path;
  });

export const RepoTreeEntry = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(['file', 'dir']),
  /** Blob size in bytes; null for a folder. */
  size: z.number().int().nonnegative().nullable(),
  /** The blob sha of a file, the tree sha of a folder. */
  sha: GitSha,
});
export type RepoTreeEntry = z.infer<typeof RepoTreeEntry>;

export const GetRepoTreeQuery = z.object({
  path: RepoFolderPath.default(''),
  ref: RepoRef.default(REPO_BRANCH),
});
export type GetRepoTreeQuery = z.infer<typeof GetRepoTreeQuery>;
/** Folders first, then files, each by name. `commitSha` is the commit `ref` resolved to. */
export const GetRepoTreeResponse = z.object({
  ref: z.string(),
  commitSha: GitSha,
  path: z.string(),
  entries: z.array(RepoTreeEntry),
});
export type GetRepoTreeResponse = z.infer<typeof GetRepoTreeResponse>;
export const getRepoTreeRoute = { method: 'GET', path: '/api/teams/:slug/repo/tree' } as const;

export const GetRepoBlobQuery = z.object({
  path: RepoFilePath,
  ref: RepoRef.default(REPO_BRANCH),
});
export type GetRepoBlobQuery = z.infer<typeof GetRepoBlobQuery>;
/** `content` is UTF-8 text; `encoding: 'base64'` only for bytes that are not text (a file git holds from before the writer's rules). */
export const GetRepoBlobResponse = z.object({
  ref: z.string(),
  commitSha: GitSha,
  path: z.string(),
  blobSha: GitSha,
  size: z.number().int().nonnegative(),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
});
export type GetRepoBlobResponse = z.infer<typeof GetRepoBlobResponse>;
export const getRepoBlobRoute = { method: 'GET', path: '/api/teams/:slug/repo/blob' } as const;

/**
 * One change. `baseBlobSha` is the blob the caller edited: when the file now holds another blob the whole commit is refused with 409
 * and the current content; `null` means "must not exist yet"; left out means last write wins. `append` adds to the end of the file
 * (creating it) and needs no base. `content` is text unless `encoding` is `base64`; bytes that are not text are refused (422).
 */
export const RepoChange = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('put'),
    path: RepoFilePath,
    content: z.string().max(2_000_000),
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
    baseBlobSha: GitSha.nullable().optional(),
  }),
  z.strictObject({
    op: z.literal('append'),
    path: RepoFilePath,
    content: z.string().max(2_000_000),
    encoding: z.enum(['utf8', 'base64']).default('utf8'),
  }),
  z.strictObject({
    op: z.literal('delete'),
    path: RepoFilePath,
    baseBlobSha: GitSha.nullable().optional(),
  }),
]);
export type RepoChange = z.infer<typeof RepoChange>;

export const MAX_REPO_CHANGES_PER_COMMIT = 200;
export const MAX_REPO_MESSAGE_LENGTH = 4000;

export const CommitRepoRequest = z.strictObject({
  changes: z.array(RepoChange).min(1).max(MAX_REPO_CHANGES_PER_COMMIT),
  message: z.string().trim().min(1).max(MAX_REPO_MESSAGE_LENGTH),
});
export type CommitRepoRequest = z.infer<typeof CommitRepoRequest>;

export const RepoCommittedPath = z.object({
  path: z.string().min(1),
  op: z.enum(['put', 'delete']),
  /** The blob now at the path; null after a delete. */
  blobSha: GitSha.nullable(),
  size: z.number().int().nonnegative().nullable(),
});
export type RepoCommittedPath = z.infer<typeof RepoCommittedPath>;

/** 201 with the new commit; 200 with `noop: true` when nothing changed (the content was already there): no commit, no event. */
export const CommitRepoResponse = z.object({
  sha: GitSha,
  parentSha: GitSha.nullable(),
  noop: z.boolean(),
  authorId: ActorId.nullable(),
  paths: z.array(RepoCommittedPath),
});
export type CommitRepoResponse = z.infer<typeof CommitRepoResponse>;
export const commitRepoRoute = { method: 'POST', path: '/api/teams/:slug/repo/commit' } as const;

/**
 * 409 `conflict`: what the files hold now, for each path whose blob is not the `baseBlobSha` the caller edited (or that is a folder, or
 * sits below a file). Nothing was written. `currentContent` is null when the file is missing or not text; the caller merges and retries.
 */
export const RepoConflict = z.object({
  path: z.string().min(1),
  reason: z.enum(['changed', 'exists', 'missing', 'folder', 'parent_is_file']),
  currentBlobSha: GitSha.nullable(),
  currentSize: z.number().int().nonnegative().nullable(),
  currentContent: z.string().nullable(),
});
export type RepoConflict = z.infer<typeof RepoConflict>;
export const RepoConflictResponse = z.object({
  error: z.object({ code: z.literal('conflict'), message: z.string() }),
  conflicts: z.array(RepoConflict).min(1),
});
export type RepoConflictResponse = z.infer<typeof RepoConflictResponse>;

export const MAX_REPO_BLOB_BYTES = REPO_MAX_FILE_BYTES;
