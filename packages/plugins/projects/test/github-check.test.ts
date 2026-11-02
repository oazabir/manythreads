import { describe, expect, it } from 'vitest';
import { checkGithubToken } from '../src/github-check.ts';

// Only a 401 from GitHub says a token is turned down. Any other odd answer says nothing about the token, so no project may change because of it.

const TOKEN = 'github_pat_0123456789abcdefghij';
const answer = (status: number, body: unknown = {}): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const ask = (fetcher: typeof fetch) => checkGithubToken({ apiBase: 'http://x', token: TOKEN, username: 'octocat', owner: 'acme', repo: 'widgets', fetch: fetcher });

describe('checkGithubToken', () => {
  it('takes only a 401 on /user as a refusal', async () => {
    expect(await ask(answer(401))).toEqual({ ok: false, problem: 'rejected' });
    for (const status of [400, 404, 410, 403, 429, 500, 503]) expect(await ask(answer(status)), String(status)).toEqual({ ok: false, problem: 'unreachable' });
  });

  it('uses a login it was given and does not ask for it again', async () => {
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const base = { apiBase: 'http://x', token: TOKEN, owner: 'acme', repo: 'widgets', fetch: fetcher };
    expect(await checkGithubToken({ ...base, username: 'octocat', user: { ok: true, login: 'OctoCat', expiresAt: null } })).toEqual({ ok: true, login: 'OctoCat', expiresAt: null });
    expect(seen).toEqual(['http://x/repos/acme/widgets']);
    expect(await checkGithubToken({ ...base, username: 'someone', user: { ok: true, login: 'octocat', expiresAt: null } })).toEqual({ ok: false, problem: 'wrong_owner' });
  });
});
