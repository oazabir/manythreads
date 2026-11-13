// Asks GitHub about a token before the project keeps it: whose it is, whether it may write to the repository, and when it expires. Like the tasks
// plugin's GitHub client it never throws, never returns text that came from the request (headers, bodies, the token) and describes a failure as
// one of four problems only.
import type { PushCredentialProblem } from '@manythreads/shared';

export type TokenCheck = { ok: true; login: string; userId: string; expiresAt: string | null } | { ok: false; problem: PushCredentialProblem };

const REQUEST_TIMEOUT_MS = 10_000;

/** Tests point GitHub at a local double; nothing else ever changes where the check goes. */
export const apiBaseFor = (real: string): string => (process.env['NODE_ENV'] === 'test' && process.env['MANYTHREADS_TEST_GITHUB_API']) || real;

/** GitHub writes the expiry as `2026-11-30 10:00:00 UTC`; null for a token that has none or a header that is not a date. */
export function parseExpiry(header: string | null): string | null {
  if (!header) return null;
  const at = Date.parse(header.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** Who a token belongs to, as GitHub says it (asked once per token, however many repositories are checked with it). */
export type TokenUser = { ok: true; login: string; userId: string; expiresAt: string | null } | { ok: false; problem: 'rejected' | 'unreachable' };

const headersFor = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'manythreads-projects',
});
const getFrom = (apiBase: string, token: string, doFetch: typeof fetch, path: string): Promise<Response> =>
  doFetch(`${apiBase}${path}`, { headers: headersFor(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });

/**
 * `GET /user`. Only a 401 says the token is turned down; any other answer that is not a 200 (a 404, 400, 410, 403, 429, 5xx) says nothing about the token, so
 * it is "unreachable", and no project changes status because of it.
 */
export async function fetchTokenUser(opts: { apiBase: string; token: string; fetch?: typeof fetch }): Promise<TokenUser> {
  const doFetch = opts.fetch ?? fetch;
  let who: Response;
  try {
    who = await getFrom(opts.apiBase, opts.token, doFetch, '/user');
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  if (who.status === 401) {
    void who.body?.cancel().catch(() => undefined);
    return { ok: false, problem: 'rejected' };
  }
  if (who.status !== 200) {
    void who.body?.cancel().catch(() => undefined);
    return { ok: false, problem: 'unreachable' };
  }
  let login = '';
  let userId = '';
  try {
    const body = (await who.json()) as { login?: unknown; id?: unknown };
    login = String(body.login ?? '');
    userId = String(body.id ?? '');
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  if (login === '') return { ok: false, problem: 'unreachable' };
  return { ok: true, login, userId, expiresAt: parseExpiry(who.headers.get('github-authentication-token-expiration')) };
}

/** `user` is the answer of `fetchTokenUser` for this token when the caller already has it (the repository is still asked about). */
export async function checkGithubToken(opts: { apiBase: string; token: string; username: string; owner: string; repo: string; fetch?: typeof fetch; user?: TokenUser }): Promise<TokenCheck> {
  const doFetch = opts.fetch ?? fetch;
  const who = opts.user ?? (await fetchTokenUser({ apiBase: opts.apiBase, token: opts.token, fetch: doFetch }));
  if (!who.ok) return { ok: false, problem: who.problem };
  if (who.login.toLowerCase() !== opts.username.toLowerCase()) return { ok: false, problem: 'wrong_owner' };

  let repo: Response;
  try {
    repo = await getFrom(opts.apiBase, opts.token, doFetch, `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`);
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  if (repo.status === 404 || repo.status === 403 || repo.status === 401) {
    void repo.body?.cancel().catch(() => undefined);
    return { ok: false, problem: 'no_write' };
  }
  if (repo.status !== 200) {
    void repo.body?.cancel().catch(() => undefined);
    return { ok: false, problem: 'unreachable' };
  }
  let canPush = false;
  try {
    canPush = ((await repo.json()) as { permissions?: { push?: unknown } }).permissions?.push === true;
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  return canPush ? { ok: true, login: who.login, userId: who.userId, expiresAt: who.expiresAt } : { ok: false, problem: 'no_write' };
}

/** What the page tells the person for each problem. */
export const PROBLEM_MESSAGE: Record<PushCredentialProblem, string> = {
  rejected: 'GitHub refused this token. Check that it was copied whole and has not expired or been revoked.',
  wrong_owner: 'This token belongs to a different GitHub account than the username you entered.',
  no_write: 'This token cannot write to this repository. It needs contents and pull requests write access to it.',
  unreachable: 'GitHub could not be reached just now, so the token was not checked. Try again in a moment.',
};
