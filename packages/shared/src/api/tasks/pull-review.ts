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

/** A lead's decision, always about the head commit the reviewer saw: refused when the request is no longer at it, or it is not the tested commit. */
export const PullRequestDecisionRequest = z.object({ headSha: z.string().regex(/^[0-9a-f]{7,64}$/) });
export type PullRequestDecisionRequest = z.infer<typeof PullRequestDecisionRequest>;

/** Asking for changes: the comment goes to the provider and, as the hand-off note, to the Coder, who works on the same card again. */
export const PullRequestChangesRequest = PullRequestDecisionRequest.extend({ comment: z.string().trim().min(1).max(800) });
export type PullRequestChangesRequest = z.infer<typeof PullRequestChangesRequest>;

export const PullRequestDecisionResponse = z.object({
  /** The provider took a comment instead of the review itself (it refuses a review by the request's own author, the bot account). */
  asComment: z.boolean(),
  /** Merge only: the card is done (the provider merged at the tested commit). */
  merged: z.boolean(),
  mergeSha: z.string().nullable(),
  /** Request changes only: the bot the card went back to. */
  handedTo: z.string().nullable(),
});
export type PullRequestDecisionResponse = z.infer<typeof PullRequestDecisionResponse>;
export const approvePullRequestRoute = { method: 'POST', path: '/api/teams/:slug/tasks/:taskId/pull-request/approve' } as const;
export const requestPullRequestChangesRoute = { method: 'POST', path: '/api/teams/:slug/tasks/:taskId/pull-request/request-changes' } as const;
export const mergePullRequestRoute = { method: 'POST', path: '/api/teams/:slug/tasks/:taskId/pull-request/merge' } as const;

/** The cards of a thread whose pull request waits for a person (a database read only: the thread does not ask the provider). */
export const ThreadPullRequest = z.object({
  taskId: z.uuid(),
  boardId: z.uuid().nullable(),
  teamSlug: z.string(),
  title: z.string(),
  number: z.number().int().positive(),
  testedSha: z.string().nullable(),
});
export type ThreadPullRequest = z.infer<typeof ThreadPullRequest>;
export const ThreadPullRequestsResponse = z.object({ items: z.array(ThreadPullRequest) });
export type ThreadPullRequestsResponse = z.infer<typeof ThreadPullRequestsResponse>;
export const threadPullRequestsRoute = { method: 'GET', path: '/api/threads/:rootId/pull-requests' } as const;
