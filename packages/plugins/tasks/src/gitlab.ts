// The GitLab side of reading a request: a merge request of a project, read with the project's token. Same promises as github.ts: it never throws, never returns
// text that came from the request (headers, bodies, the token) and describes every failure as a status code or an error name only. The answer has the same
// shape as a GitHub pull request's (`PullInfo`), so the recording and the sync do not care which provider they ask.
import { MAX_BACKOFF_MS, type GithubOptions, type PullAnswer } from './github.ts';

const REQUEST_TIMEOUT_MS = 10_000;

const lower = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.toLowerCase() : null);

/** GitLab's states: `opened`, `closed`, `locked` (being merged) and `merged`. A locked request is still open for our purposes. */
export async function getMergeRequest(opts: GithubOptions & { apiBase: string; token: string; path: string; number: number; failures: number }): Promise<PullAnswer> {
  const doFetch = opts.fetch ?? fetch;
  const backoffMs = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(opts.failures, 6));
  let res: Response;
  try {
    res = await doFetch(`${opts.apiBase}/projects/${encodeURIComponent(opts.path)}/merge_requests/${opts.number}`, {
      headers: { 'private-token': opts.token, accept: 'application/json', 'user-agent': 'manythreads-pull-requests' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    return { kind: 'retry', waitMs: backoffMs, why: `request failed (${err instanceof Error ? err.name : 'error'})` };
  }
  if (res.status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'retry', waitMs: backoffMs, why: 'unreadable answer' };
    }
    const b = body as {
      state?: unknown;
      merged_at?: unknown;
      source_branch?: unknown;
      target_branch?: unknown;
      sha?: unknown;
      merge_commit_sha?: unknown;
      squash_commit_sha?: unknown;
      source_project_id?: unknown;
      target_project_id?: unknown;
      references?: { full?: unknown };
    };
    if (b.state !== 'opened' && b.state !== 'closed' && b.state !== 'locked' && b.state !== 'merged') return { kind: 'retry', waitMs: backoffMs, why: 'unexpected answer' };
    const merged = b.state === 'merged';
    const pick = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v.toLowerCase() : null);
    // a request merged by a fast-forward or a squash has no merge commit; the commit that landed is the squash commit, else the head itself
    const landed = pick(b.merge_commit_sha) ?? pick(b.squash_commit_sha) ?? pick(b.sha);
    // `references.full` is `group/sub/project!7`: the project's own path, which is how both ends of the request are named
    const full = typeof b.references?.full === 'string' ? b.references.full.split('!')[0] : undefined;
    const baseRepo = lower(full);
    const sameProject = b.source_project_id !== undefined && b.source_project_id === b.target_project_id;
    return {
      kind: 'ok',
      pull: {
        state: b.state === 'opened' || b.state === 'locked' ? 'open' : 'closed',
        merged,
        mergeSha: merged ? landed : null,
        headRef: typeof b.source_branch === 'string' ? b.source_branch : null,
        baseRef: typeof b.target_branch === 'string' ? b.target_branch : null,
        headSha: lower(b.sha),
        baseRepo,
        // a request from a fork has another source project: it can never equal the base
        headRepo: sameProject ? baseRepo : baseRepo === null ? null : `fork-of:${baseRepo}`,
      },
    };
  }
  void res.body?.cancel().catch(() => undefined);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs;
    return { kind: 'retry', waitMs: Math.min(MAX_BACKOFF_MS, Math.max(30_000, wait)), why: 'status 429' };
  }
  if (res.status === 401) return { kind: 'retry', waitMs: MAX_BACKOFF_MS, why: "status 401 (the project's token was refused)", refused: true };
  return { kind: 'retry', waitMs: backoffMs, why: `status ${res.status}` };
}
