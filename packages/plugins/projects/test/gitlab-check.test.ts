import { describe, expect, it } from 'vitest';
import { checkGitlabToken, fetchGitlabTokenUser, parseGitlabExpiry } from '../src/gitlab-check.ts';
import { problemMessage } from '../src/provider-check.ts';

// GitLab's check follows GitHub's: only a 401 turns a token down; the project's role decides whether it can push; a host that does not answer says nothing.

const TOKEN = 'glpat-0123456789abcdefghij';
type Reply = { status: number; body?: unknown };
/** A fake GitLab: the first matching path prefix answers; the requests are kept so a test can see what was asked and with which header. */
function gitlab(replies: Record<string, Reply>, seen: Array<{ url: string; token: string | null }> = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), token: new Headers(init?.headers).get('private-token') });
    const key = Object.keys(replies).find((k) => String(url).startsWith(`http://x${k}`));
    const r = key ? replies[key]! : { status: 404 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
}
const ask = (fetcher: typeof fetch, username = 'bot') => checkGitlabToken({ apiBase: 'http://x', token: TOKEN, username, path: 'grp/sub/widgets', fetch: fetcher });
const me = { '/user': { status: 200, body: { username: 'Bot', id: 77 } }, '/personal_access_tokens/self': { status: 200, body: { expires_at: '2026-12-01' } } };

describe('checkGitlabToken', () => {
  it('sends the token in PRIVATE-TOKEN and asks for the project by its encoded path', async () => {
    const seen: Array<{ url: string; token: string | null }> = [];
    const r = await ask(gitlab({ ...me, '/projects/grp%2Fsub%2Fwidgets': { status: 200, body: { permissions: { project_access: { access_level: 30 } } } } }, seen));
    expect(r).toEqual({ ok: true, login: 'Bot', userId: '77', expiresAt: '2026-12-01T23:59:59.000Z' });
    expect(seen.every((s) => s.token === TOKEN)).toBe(true);
    expect(seen.map((s) => s.url)).toContain('http://x/projects/grp%2Fsub%2Fwidgets');
  });

  it('takes a role through the group as well, and refuses a Reporter', async () => {
    const withGroup = gitlab({ ...me, '/projects/': { status: 200, body: { permissions: { project_access: null, group_access: { access_level: 40 } } } } });
    expect((await ask(withGroup)).ok).toBe(true);
    const reporter = gitlab({ ...me, '/projects/': { status: 200, body: { permissions: { project_access: { access_level: 20 } } } } });
    expect(await ask(reporter)).toEqual({ ok: false, problem: 'no_write' });
  });

  it('tells a token of another account, an invisible project and a refused token apart', async () => {
    expect(await ask(gitlab(me), 'someone-else')).toEqual({ ok: false, problem: 'wrong_owner' });
    expect(await ask(gitlab({ ...me, '/projects/': { status: 404 } }))).toEqual({ ok: false, problem: 'no_write' });
    expect(await ask(gitlab({ '/user': { status: 401 } }))).toEqual({ ok: false, problem: 'rejected' });
  });

  it('takes any answer but 401 on /user as "could not check"', async () => {
    for (const status of [400, 403, 404, 429, 500, 503]) expect(await ask(gitlab({ '/user': { status } })), String(status)).toEqual({ ok: false, problem: 'unreachable' });
    const down = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await fetchGitlabTokenUser({ apiBase: 'http://x', token: TOKEN, fetch: down })).toEqual({ ok: false, problem: 'unreachable' });
  });

  it('keeps a token that cannot say when it ends', async () => {
    const r = await fetchGitlabTokenUser({ apiBase: 'http://x', token: TOKEN, fetch: gitlab({ '/user': { status: 200, body: { username: 'bot', id: 5 } } }) });
    expect(r).toEqual({ ok: true, login: 'bot', userId: '5', expiresAt: null });
  });
});

describe('gitlab helpers', () => {
  it('reads an expiry date and names the provider in a message', () => {
    expect(parseGitlabExpiry(null)).toBeNull();
    expect(parseGitlabExpiry('not a date')).toBeNull();
    expect(problemMessage('gitlab', 'no_write')).toContain('Developer');
    expect(problemMessage('github', 'rejected')).toContain('GitHub');
  });
});
