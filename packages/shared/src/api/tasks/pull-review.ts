import { z } from 'zod';

// P35-02: reviewing a bot's pull request (GitHub) or merge request (GitLab) on its card, without leaving for the provider. The server reads the provider
// with the project's token (`project.credentials`); the browser only ever sees these shapes. Patch text is the provider's, untrusted: drawn as text only.

/** One file of the change. `patch` is the unified diff of the file's hunks (no `---`/`+++` header); null for a binary file or one too large to show. */
export const PullRequestFile = z.object({
  path: z.string().max(4096),
  /** The old path of a renamed (or copied) file; null otherwise. */
  previousPath: z.string().max(4096).nullable(),
  status: z.enum(['added', 'deleted', 'modified', 'renamed', 'copied', 'changed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  /** The patch was cut, or the provider left it out because the file is too large: the reviewer opens the provider for the rest. */
  truncated: z.boolean(),
  patch: z.string().nullable(),
});
export type PullRequestFile = z.infer<typeof PullRequestFile>;

export const PullRequestDiffResponse = z.object({
  number: z.number().int().positive(),
  /** The provider's page of the request, for what is not shown here. */
  url: z.string(),
  /** The commit the request is at now, and whether that is still the commit recorded on the card (the tested work). */
  headSha: z.string().nullable(),
  atRecordedHead: z.boolean(),
  page: z.number().int().positive(),
  /** The next page of files, or null on the last one. */
  nextPage: z.number().int().positive().nullable(),
  files: z.array(PullRequestFile),
});
export type PullRequestDiffResponse = z.infer<typeof PullRequestDiffResponse>;
export const pullRequestDiffRoute = { method: 'GET', path: '/api/teams/:slug/tasks/:taskId/pull-request/diff' } as const;

/** One CI check (GitHub check run or commit status; a GitLab pipeline or job). `link` is https only. */
export const PullRequestCheck = z.object({
  name: z.string().max(300),
  state: z.enum(['passing', 'failing', 'pending', 'skipped']),
  link: z.string().nullable(),
});
export type PullRequestCheck = z.infer<typeof PullRequestCheck>;

export const PullRequestChecksResponse = z.object({
  headSha: z.string().nullable(),
  atRecordedHead: z.boolean(),
  /** failing when any check fails; pending when any still runs; passing when all passed; none when the provider reports no check. */
  summary: z.enum(['passing', 'failing', 'pending', 'none']),
  checks: z.array(PullRequestCheck),
  /** Set when the token may not read checks: the words say which permission the project's token needs. */
  unreadable: z.string().nullable(),
});
export type PullRequestChecksResponse = z.infer<typeof PullRequestChecksResponse>;
export const pullRequestChecksRoute = { method: 'GET', path: '/api/teams/:slug/tasks/:taskId/pull-request/checks' } as const;
