// Asking GitLab (gitlab.com or a self-hosted installation) about a bot account's token before it is kept or used: whose it is and whether it can open merge
// requests on the project. Same four problems as GitHub's check, so the page and the sync treat both alike. Nothing here is logged, and the token only goes
// in the `PRIVATE-TOKEN` header of a request to the project's own host.
import type { TokenCheck, TokenUser } from './github-check.ts';

const REQUEST_TIMEOUT_MS = 10_000;

/** GitLab's Developer role: the lowest that can push a branch and open a merge request. */
const DEVELOPER = 30;

const getFrom = (apiBase: string, token: string, doFetch: typeof fetch, path: string): Promise<Response> =>
  doFetch(`${apiBase}${path}`, { headers: { 'private-token': token, accept: 'application/json', 'user-agent': 'manythreads-projects' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error' });

/** GitLab writes the expiry of a token as a date (`2026-12-01`) in `GET /personal_access_tokens/self`; null for a token that has none. */
export function parseGitlabExpiry(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const at = Date.parse(`${value}T23:59:59Z`);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** `GET /user` (who the token belongs to) and `GET /personal_access_tokens/self` (when it ends; a project access token answers there too). Only a 401 turns the token down. */
export async function fetchGitlabTokenUser(opts: { apiBase: string; token: string; fetch?: typeof fetch }): Promise<TokenUser> {
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
    const body = (await who.json()) as { username?: unknown; id?: unknown };
    login = String(body.username ?? '');
    userId = String(body.id ?? '');
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  if (login === '' || userId === '') return { ok: false, problem: 'unreachable' };
  let expiresAt: string | null = null;
  try {
    const self = await getFrom(opts.apiBase, opts.token, doFetch, '/personal_access_tokens/self');
    if (self.status === 200) expiresAt = parseGitlabExpiry(((await self.json()) as { expires_at?: unknown }).expires_at);
    else void self.body?.cancel().catch(() => undefined);
  } catch {
    // the expiry is a nicety: a token that cannot say when it ends is still a good token
  }
  return { ok: true, login, userId, expiresAt };
}

/** `user` is the answer of `fetchGitlabTokenUser` for this token when the caller already has it. `path` is the project's full path (`group/sub/repo`). */
export async function checkGitlabToken(opts: { apiBase: string; token: string; username: string; path: string; fetch?: typeof fetch; user?: TokenUser }): Promise<TokenCheck> {
  const doFetch = opts.fetch ?? fetch;
  const who = opts.user ?? (await fetchGitlabTokenUser({ apiBase: opts.apiBase, token: opts.token, fetch: doFetch }));
  if (!who.ok) return { ok: false, problem: who.problem };
  if (who.login.toLowerCase() !== opts.username.toLowerCase()) return { ok: false, problem: 'wrong_owner' };

  let project: Response;
  try {
    project = await getFrom(opts.apiBase, opts.token, doFetch, `/projects/${encodeURIComponent(opts.path)}`);
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  if (project.status === 404 || project.status === 403 || project.status === 401) {
    void project.body?.cancel().catch(() => undefined);
    return { ok: false, problem: 'no_write' };
  }
  if (project.status !== 200) {
    void project.body?.cancel().catch(() => undefined);
    return { ok: false, problem: 'unreachable' };
  }
  let level = 0;
  try {
    const p = (await project.json()) as { permissions?: { project_access?: { access_level?: unknown } | null; group_access?: { access_level?: unknown } | null } };
    const project_level = Number(p.permissions?.project_access?.access_level ?? 0);
    const group_level = Number(p.permissions?.group_access?.access_level ?? 0);
    level = Math.max(Number.isFinite(project_level) ? project_level : 0, Number.isFinite(group_level) ? group_level : 0);
  } catch {
    return { ok: false, problem: 'unreachable' };
  }
  return level >= DEVELOPER ? { ok: true, login: who.login, userId: who.userId, expiresAt: who.expiresAt } : { ok: false, problem: 'no_write' };
}
