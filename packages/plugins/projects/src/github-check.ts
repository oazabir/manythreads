// Asks GitHub about a token before the project keeps it: whose it is, whether it may write to the repository, and when it expires. Like the tasks
// plugin's GitHub client it never throws, never returns text that came from the request (headers, bodies, the token) and describes a failure as
// one of four problems only.
import type { PushCredentialProblem } from '@manythreads/shared';

export type TokenCheck = { ok: true; login: string; expiresAt: string | null } | { ok: false; problem: PushCredentialProblem };

const REQUEST_TIMEOUT_MS = 10_000;

/** GitHub writes the expiry as `2026-11-30 10:00:00 UTC`; null for a token that has none or a header that is not a date. */
export function parseExpiry(header: string | null): string | null {
  if (!header) return null;
  const at = Date.parse(header.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

export async function checkGithubToken(opts: { apiBase: string; token: string; username: string; owner: string; repo: string; fetch?: typeof fetch }): Promise<TokenCheck> {
  const doFetch = opts.fetch ?? fetch;
  const get = (path: string): Promise<Response> =>
    doFetch(`${opts.apiBase}${path}`, {
      headers: { authorization: `Bearer ${opts.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'manythreads-projects' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  let who: Response;
  try {
    who = await get('/user');
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  if (who.status === 401) {
    void who.body?.cancel().catch(() => undefined);
    return { ok: false, problem: 'rejected' };
  }
  if (who.status !== 200) {
    void who.body?.cancel().catch(() => undefined);
    return { ok: false, problem: who.status === 403 || who.status === 429 || who.status >= 500 ? 'unreachable' : 'rejected' };
  }
  let login = '';
  try {
    login = String(((await who.json()) as { login?: unknown }).login ?? '');
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  if (login === '') return { ok: false, problem: 'unreachable' };
  if (login.toLowerCase() !== opts.username.toLowerCase()) return { ok: false, problem: 'wrong_owner' };
  const expiresAt = parseExpiry(who.headers.get('github-authentication-token-expiration'));

  let repo: Response;
  try {
    repo = await get(`/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`);
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
  return canPush ? { ok: true, login, expiresAt } : { ok: false, problem: 'no_write' };
}

/** What the page tells the person for each problem. */
export const PROBLEM_MESSAGE: Record<PushCredentialProblem, string> = {
  rejected: 'GitHub refused this token. Check that it was copied whole and has not expired or been revoked.',
  wrong_owner: 'This token belongs to a different GitHub account than the username you entered.',
  no_write: 'This token cannot write to this repository. It needs contents and pull requests write access to it.',
  unreachable: 'GitHub could not be reached just now, so the token was not checked. Try again in a moment.',
};
