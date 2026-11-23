// P35-02: what a person needs to review a bot's pull request (GitHub) or merge request (GitLab) on its card: the files with their hunks, and the CI
// checks of the head. Read with the project's own token (`project.credentials`), by server code only. Same promises as github.ts: never throws out of a
// provider call, never returns text that came from a response's headers or an error body, never the token; a failure is a status code or an error name.
// The patch text itself is the provider's and untrusted: it goes to the browser as text and is drawn as text.
import type { PullRequestCheck, PullRequestFile } from '@manythreads/shared';
import type { GitRepo } from '@manythreads/shared';
import type { GithubOptions } from './github.ts';

const REQUEST_TIMEOUT_MS = 10_000;
/** Files a page (GitHub's default); GitHub lists at most 3000 files of a pull request, so 100 pages. */
export const FILES_PER_PAGE = 30;
export const MAX_PAGE = 100;
/** A file's patch longer than this is left out (the reviewer opens the provider); a page's patches stop at the second cap. */
export const MAX_PATCH_BYTES = 64 * 1024;
export const MAX_PAGE_PATCH_BYTES = 256 * 1024;

export type ProviderFail = { ok: false; status: number | null; why: string; refused?: true };
type ProviderOk = { ok: true; body: unknown; headers: Headers };

export interface ProviderTarget extends GithubOptions {
  repo: GitRepo;
  token: string;
  /** The API base actually asked (the repo's own, or a test double's). */
  apiBase: string;
}

const projectPath = (t: ProviderTarget): string =>
  t.repo.provider === 'github' ? `/repos/${encodeURIComponent(t.repo.owner)}/${encodeURIComponent(t.repo.repo)}` : `/projects/${encodeURIComponent(t.repo.path)}`;

/** One call to the provider with the project's token. */
export async function providerCall(t: ProviderTarget, path: string, init: { method?: string; body?: unknown } = {}): Promise<ProviderOk | ProviderFail> {
  const doFetch = t.fetch ?? fetch;
  const headers: Record<string, string> =
    t.repo.provider === 'github'
      ? { authorization: `Bearer ${t.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'manythreads-pull-requests' }
      : { 'private-token': t.token, accept: 'application/json', 'user-agent': 'manythreads-pull-requests' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await doFetch(`${t.apiBase}${projectPath(t)}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    return { ok: false, status: null, why: `request failed (${err instanceof Error ? err.name : 'error'})` };
  }
  if (res.status >= 200 && res.status < 300) {
    try {
      return { ok: true, body: res.status === 204 ? null : await res.json(), headers: res.headers };
    } catch {
      return { ok: false, status: res.status, why: 'unreadable answer' };
    }
  }
  void res.body?.cancel().catch(() => undefined);
  if (res.status === 401) return { ok: false, status: 401, why: "status 401 (the project's token was refused)", refused: true };
  return { ok: false, status: res.status, why: `status ${res.status}` };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
const httpsLink = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) && v.length <= 2048 ? v : null);

/** Lines added and removed in a hunk text (GitLab gives no counts). */
function tally(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/** Applies the two caps in order over a page: a file over its own cap, or one that would take the page over its cap, keeps its name and counts only. */
function capPatches(files: PullRequestFile[]): PullRequestFile[] {
  let total = 0;
  return files.map((f) => {
    if (f.patch === null) return f;
    const size = Buffer.byteLength(f.patch, 'utf8');
    if (size > MAX_PATCH_BYTES || total + size > MAX_PAGE_PATCH_BYTES) return { ...f, patch: null, truncated: true };
    total += size;
    return f;
  });
}

const GITHUB_STATUS: Record<string, PullRequestFile['status']> = { added: 'added', removed: 'deleted', modified: 'modified', renamed: 'renamed', copied: 'copied', changed: 'changed', unchanged: 'changed' };

function githubFile(raw: unknown): PullRequestFile | null {
  const f = raw as { filename?: unknown; previous_filename?: unknown; status?: unknown; additions?: unknown; deletions?: unknown; patch?: unknown };
  const path = str(f.filename);
  if (path === null) return null;
  const status = GITHUB_STATUS[str(f.status) ?? ''] ?? 'modified';
  const additions = count(f.additions);
  const deletions = count(f.deletions);
  const patch = str(f.patch);
  // GitHub leaves `patch` out for a binary file and for a text file too large to diff: one with counted lines is the second
  const noPatch = patch === null;
  const binary = noPatch && additions + deletions === 0 && status !== 'renamed' && status !== 'copied';
  const truncated = noPatch && additions + deletions > 0;
  return { path, previousPath: status === 'renamed' || status === 'copied' ? str(f.previous_filename) : null, status, additions, deletions, binary, truncated, patch };
}

function gitlabFile(raw: unknown): PullRequestFile | null {
  const f = raw as { old_path?: unknown; new_path?: unknown; new_file?: unknown; renamed_file?: unknown; deleted_file?: unknown; diff?: unknown; too_large?: unknown; collapsed?: unknown };
  const path = str(f.new_path) ?? str(f.old_path);
  if (path === null) return null;
  const status: PullRequestFile['status'] = f.new_file === true ? 'added' : f.deleted_file === true ? 'deleted' : f.renamed_file === true ? 'renamed' : 'modified';
  const diff = str(f.diff) ?? '';
  const tooLarge = f.too_large === true || f.collapsed === true;
  const binary = /^Binary files .* differ$/m.test(diff);
  const patch = binary || tooLarge || diff === '' ? null : diff.replace(/\n$/, '');
  const { additions, deletions } = patch ? tally(patch) : { additions: 0, deletions: 0 };
  return { path, previousPath: status === 'renamed' ? str(f.old_path) : null, status, additions, deletions, binary, truncated: tooLarge, patch };
}

/** One page of the request's files. */
export async function listRequestFiles(t: ProviderTarget, number: number, page: number): Promise<{ ok: true; files: PullRequestFile[]; nextPage: number | null } | ProviderFail> {
  const path =
    t.repo.provider === 'github' ? `/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}` : `/merge_requests/${number}/diffs?per_page=${FILES_PER_PAGE}&page=${page}`;
  const r = await providerCall(t, path);
  if (!r.ok) return r;
  if (!Array.isArray(r.body)) return { ok: false, status: null, why: 'unexpected answer' };
  const read = t.repo.provider === 'github' ? githubFile : gitlabFile;
  const files = capPatches(r.body.map(read).filter((f): f is PullRequestFile => f !== null));
  // GitHub says so in its Link header; GitLab in `x-next-page`
  const more = t.repo.provider === 'github' ? /rel="next"/.test(r.headers.get('link') ?? '') : /^\d+$/.test(r.headers.get('x-next-page') ?? '');
  return { ok: true, files, nextPage: more && page < MAX_PAGE ? page + 1 : null };
}

function githubRun(raw: unknown): PullRequestCheck | null {
  const c = raw as { name?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown };
  const name = str(c.name);
  if (name === null) return null;
  const conclusion = str(c.conclusion);
  const state: PullRequestCheck['state'] =
    c.status !== 'completed' || conclusion === 'stale' ? 'pending' : conclusion === 'success' || conclusion === 'neutral' ? 'passing' : conclusion === 'skipped' ? 'skipped' : 'failing';
  return { name: name.slice(0, 300), state, link: httpsLink(c.html_url) };
}

function githubStatus(raw: unknown): PullRequestCheck | null {
  const s = raw as { context?: unknown; state?: unknown; target_url?: unknown };
  const name = str(s.context);
  if (name === null) return null;
  const state: PullRequestCheck['state'] = s.state === 'success' ? 'passing' : s.state === 'pending' ? 'pending' : 'failing';
  return { name: name.slice(0, 300), state, link: httpsLink(s.target_url) };
}

const GITLAB_PIPELINE: Record<string, PullRequestCheck['state']> = { success: 'passing', failed: 'failing', canceled: 'failing', skipped: 'skipped', manual: 'skipped' };

export const CHECKS_UNREADABLE = {
  github: "The project's token cannot read checks: give it the Checks and Commit statuses permissions (read) on the Projects page.",
  gitlab: "The project's token cannot read pipelines: it needs the read_api scope (or api) on the Projects page.",
} as const;

export function summarize(checks: PullRequestCheck[]): 'passing' | 'failing' | 'pending' | 'none' {
  if (checks.some((c) => c.state === 'failing')) return 'failing';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  return checks.some((c) => c.state === 'passing') ? 'passing' : 'none';
}

/** The checks of the head commit `head`: GitHub's check runs and commit statuses, or the GitLab pipelines of the merge request at that commit. */
export async function listRequestChecks(t: ProviderTarget, number: number, head: string): Promise<{ ok: true; checks: PullRequestCheck[]; unreadable: string | null } | ProviderFail> {
  if (!/^[0-9a-f]{7,64}$/.test(head)) return { ok: false, status: null, why: 'no head commit' };
  if (t.repo.provider === 'github') {
    const runs = await providerCall(t, `/commits/${head}/check-runs?per_page=100`);
    const statuses = await providerCall(t, `/commits/${head}/status?per_page=100`);
    for (const r of [runs, statuses]) if (!r.ok && r.refused) return r;
    const denied = [runs, statuses].some((r) => !r.ok && (r.status === 403 || r.status === 404));
    if (!runs.ok && !statuses.ok && !denied) return runs;
    const list: PullRequestCheck[] = [];
    if (runs.ok) for (const c of ((runs.body as { check_runs?: unknown[] }).check_runs ?? []).map(githubRun)) if (c) list.push(c);
    if (statuses.ok) for (const c of ((statuses.body as { statuses?: unknown[] }).statuses ?? []).map(githubStatus)) if (c) list.push(c);
    return { ok: true, checks: list, unreadable: denied ? CHECKS_UNREADABLE.github : null };
  }
  const r = await providerCall(t, `/merge_requests/${number}/pipelines`);
  if (!r.ok) return r.status === 403 || r.status === 404 ? { ok: true, checks: [], unreadable: CHECKS_UNREADABLE.gitlab } : r;
  if (!Array.isArray(r.body)) return { ok: false, status: null, why: 'unexpected answer' };
  const atHead = r.body.find((p) => str((p as { sha?: unknown }).sha)?.toLowerCase() === head) as { id?: unknown; status?: unknown; web_url?: unknown } | undefined;
  if (!atHead) return { ok: true, checks: [], unreadable: null };
  const state = GITLAB_PIPELINE[str(atHead.status) ?? ''] ?? 'pending';
  return { ok: true, checks: [{ name: `Pipeline #${count(atHead.id)}`, state, link: httpsLink(atHead.web_url) }], unreadable: null };
}

/** What a decision did on the provider: `fallback` when the provider would not take the review itself (the bot account opened the request) and a comment says it. */
export type ReviewOutcome = { ok: true; fallback: boolean } | ProviderFail;

/**
 * Approve (or ask for changes on) the request at `head`, signed by the bot account the token belongs to, saying who decided. GitHub refuses a review by
 * the request's own author (422; the bot account opened it), GitLab an approval by it (401 on approve is the token, 403/405/409 the rule): both fall back to a
 * comment, so the provider still shows the decision.
 */
export async function submitReview(t: ProviderTarget, number: number, head: string, verdict: 'approve' | 'request_changes', words: string): Promise<ReviewOutcome> {
  if (t.repo.provider === 'github') {
    const event = verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';
    const r = await providerCall(t, `/pulls/${number}/reviews`, { method: 'POST', body: { commit_id: head, event, body: words } });
    if (r.ok) return { ok: true, fallback: false };
    if (r.status !== 422) return r;
    const c = await providerCall(t, `/pulls/${number}/reviews`, { method: 'POST', body: { commit_id: head, event: 'COMMENT', body: words } });
    return c.ok ? { ok: true, fallback: true } : c;
  }
  if (verdict === 'approve') {
    const r = await providerCall(t, `/merge_requests/${number}/approve`, { method: 'POST', body: { sha: head } });
    if (r.ok) return { ok: true, fallback: false };
    if (r.refused || (r.status !== 403 && r.status !== 405 && r.status !== 409 && r.status !== 401)) return r;
  }
  const n = await providerCall(t, `/merge_requests/${number}/notes`, { method: 'POST', body: { body: words } });
  return n.ok ? { ok: true, fallback: verdict === 'approve' } : n;
}

/** Merge the request only at `head` (P6-04): the provider itself refuses when the request moved. A plain merge (the Committer already made one commit). */
export async function mergeRequest(t: ProviderTarget, number: number, head: string): Promise<{ ok: true; mergeSha: string | null } | (ProviderFail & { words?: string })> {
  const pick = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v.toLowerCase() : null);
  if (t.repo.provider === 'github') {
    const r = await providerCall(t, `/pulls/${number}/merge`, { method: 'PUT', body: { sha: head, merge_method: 'merge' } });
    if (r.ok) return { ok: true, mergeSha: pick((r.body as { sha?: unknown } | null)?.sha) };
    if (r.status === 409) return { ...r, words: 'The pull request moved past the tested commit: it was not merged. Test the new commit first.' };
    if (r.status === 405) return { ...r, words: 'GitHub will not merge it yet (a required review or check, or a conflict with the main branch).' };
    return r;
  }
  const r = await providerCall(t, `/merge_requests/${number}/merge`, { method: 'PUT', body: { sha: head } });
  if (r.ok) {
    const b = r.body as { merge_commit_sha?: unknown; squash_commit_sha?: unknown } | null;
    return { ok: true, mergeSha: pick(b?.merge_commit_sha) ?? pick(b?.squash_commit_sha) ?? head };
  }
  if (r.status === 409) return { ...r, words: 'The merge request moved past the tested commit: it was not merged. Test the new commit first.' };
  if (r.status === 405 || r.status === 406 || r.status === 422) return { ...r, words: 'GitLab will not merge it yet (an approval rule, a pipeline, or a conflict with the main branch).' };
  return r;
}
