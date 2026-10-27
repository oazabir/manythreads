// The one place the tasks plugin talks to GitHub: read a pull request with a project's token. It never throws, never returns text that came from the
// request (headers, bodies, the token) and describes every failure as a status code or an error name only.

export interface PullInfo {
  state: 'open' | 'closed';
  merged: boolean;
  /** The merge commit, lower case; null until merged. */
  mergeSha: string | null;
  headRef: string | null;
  /** The branch the pull request is aimed at. */
  baseRef: string | null;
  headSha: string | null;
  /** `owner/repo` of the repository the pull request is aimed at, and of the one it comes from (a fork differs). Lower case. */
  baseRepo: string | null;
  headRepo: string | null;
}

export type PullAnswer = { kind: 'ok'; pull: PullInfo } | { kind: 'retry'; waitMs: number; why: string };

export interface GithubOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_BACKOFF_MS = 30 * 60_000;

const lower = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.toLowerCase() : null);

export async function getPull(opts: GithubOptions & { apiBase: string; token: string; owner: string; repo: string; number: number; failures: number }): Promise<PullAnswer> {
  const doFetch = opts.fetch ?? fetch;
  const backoffMs = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(opts.failures, 6));
  let res: Response;
  try {
    res = await doFetch(`${opts.apiBase}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/pulls/${opts.number}`, {
      headers: { authorization: `Bearer ${opts.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'manythreads-pull-requests' },
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
      merged?: unknown;
      merged_at?: unknown;
      merge_commit_sha?: unknown;
      head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null };
      base?: { ref?: unknown; repo?: { full_name?: unknown } | null };
    };
    if (b.state !== 'open' && b.state !== 'closed') return { kind: 'retry', waitMs: backoffMs, why: 'unexpected answer' };
    const merged = b.merged === true || (typeof b.merged_at === 'string' && b.merged_at !== '');
    const sha = typeof b.merge_commit_sha === 'string' && /^[0-9a-f]{7,64}$/i.test(b.merge_commit_sha) ? b.merge_commit_sha.toLowerCase() : null;
    return {
      kind: 'ok',
      pull: {
        state: b.state,
        merged,
        mergeSha: merged ? sha : null,
        headRef: typeof b.head?.ref === 'string' ? b.head.ref : null,
        baseRef: typeof b.base?.ref === 'string' ? b.base.ref : null,
        headSha: lower(b.head?.sha),
        baseRepo: lower(b.base?.repo?.full_name),
        headRepo: lower(b.head?.repo?.full_name),
      },
    };
  }
  void res.body?.cancel().catch(() => undefined);
  if (res.status === 403 || res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const now = (opts.now ?? Date.now)();
    let wait = backoffMs;
    if (Number.isFinite(retryAfter) && retryAfter > 0) wait = retryAfter * 1000;
    else if (res.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) wait = Math.max(0, reset * 1000 - now);
    return { kind: 'retry', waitMs: Math.min(MAX_BACKOFF_MS, Math.max(30_000, wait)), why: `status ${res.status}` };
  }
  if (res.status === 401) return { kind: 'retry', waitMs: MAX_BACKOFF_MS, why: "status 401 (the project's token was refused)" };
  return { kind: 'retry', waitMs: backoffMs, why: `status ${res.status}` };
}
