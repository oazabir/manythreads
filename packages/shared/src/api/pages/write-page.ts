import { z } from 'zod';
import { GitSha } from '../../entities/repo.ts';
import { RepoFilePath } from '../repo/repo.ts';
import { ActorId } from '../../ids.ts';

// `pages.write` (SPEC section 6.4, PLAN P4-07): plain file write plus commit for durable pages (reports, saved answers, routine outputs). A page is a text
// file under `pages/` in the team repo; every write is one commit with the caller as author. (Concurrent live editing with Yjs arrives in phase 6.)

export const PAGES_DIR = 'pages';
export const PAGE_WRITE_MODES = ['create', 'replace', 'append'] as const;
export const PageWriteMode = z.enum(PAGE_WRITE_MODES);
export type PageWriteMode = z.infer<typeof PageWriteMode>;

export const MAX_PAGE_BYTES = 1_048_576;

/** A path inside `pages/` (strict, same rules as every repo path). */
export const PagePath = RepoFilePath.refine((p) => p.startsWith(`${PAGES_DIR}/`) && p.length > PAGES_DIR.length + 1, {
  message: 'a page lives under pages/ (for example pages/reports/week-37.md)',
});

export const WritePagePathParams = z.object({ slug: z.string().min(1).max(63) });
export type WritePagePathParams = z.infer<typeof WritePagePathParams>;

/**
 * `create`: the page must not exist (409 `conflict` with the current content when it does). `replace`: the whole page becomes `content` (it is created if
 * missing); with `baseBlobSha` it is refused (409) when the page changed since the caller read it. `append`: `content` is added to the end (the page is
 * created if missing), read inside the writer's lock so two appends never lose one.
 */
export const WritePageRequest = z.strictObject({
  mode: PageWriteMode,
  path: PagePath,
  content: z.string().max(2_000_000),
  baseBlobSha: GitSha.optional(),
  /** The commit message; default `<Create|Replace|Append to> <path>`. */
  message: z.string().trim().min(1).max(4000).optional(),
});
export type WritePageRequest = z.infer<typeof WritePageRequest>;

/** 201 with the new commit; 200 with `noop: true` when the page already held exactly that (no commit, no event). */
export const WritePageResponse = z.object({
  path: z.string(),
  mode: PageWriteMode,
  sha: GitSha,
  parentSha: GitSha.nullable(),
  noop: z.boolean(),
  authorId: ActorId.nullable(),
  blobSha: GitSha.nullable(),
  size: z.number().int().nonnegative().nullable(),
});
export type WritePageResponse = z.infer<typeof WritePageResponse>;
export const writePageRoute = { method: 'POST', path: '/api/teams/:slug/pages/write' } as const;
