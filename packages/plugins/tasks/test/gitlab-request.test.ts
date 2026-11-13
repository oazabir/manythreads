import type { ProjectCredentialsProvider } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { getMergeRequest } from '../src/gitlab.ts';
import { verifyPullRequest, type PullRequestDeps } from '../src/pull-requests.ts';

// A GitLab merge request is read like a GitHub pull request: same facts, same refusals. GitLab is a fake `fetch` here; nothing leaves the process.

const TOKEN = 'glpat-ToolTestToken0123456789';
const ORIGIN = 'https://git.example/grp/sub/widgets';
const TASK = '01a16e30-0000-7000-8000-0000000000b1';
const BRANCH = 'card-01a16e30';
const TESTED = 'c'.repeat(40);
const SQUASHED = 'a'.repeat(40);

const mr = (over: Record<string, unknown> = {}) => ({
  state: 'opened',
  source_branch: BRANCH,
  target_branch: 'main',
  sha: SQUASHED,
  source_project_id: 5,
  target_project_id: 5,
  references: { full: 'grp/sub/widgets!7' },
  ...over,
});
function gitlab(body: unknown, status = 200, seen: Array<{ url: string; token: string | null }> = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), token: new Headers(init?.headers).get('private-token') });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}
const read = (f: typeof fetch) => getMergeRequest({ apiBase: 'https://git.example/api/v4', token: TOKEN, path: 'grp/sub/widgets', number: 7, failures: 0, fetch: f });

describe('getMergeRequest', () => {
  it('reads the facts a pull request has, asking for the project by its encoded path with the token in PRIVATE-TOKEN', async () => {
    const seen: Array<{ url: string; token: string | null }> = [];
    expect(await read(gitlab(mr(), 200, seen))).toEqual({
      kind: 'ok',
      pull: { state: 'open', merged: false, mergeSha: null, headRef: BRANCH, baseRef: 'main', headSha: SQUASHED, baseRepo: 'grp/sub/widgets', headRepo: 'grp/sub/widgets' },
    });
    expect(seen).toEqual([{ url: 'https://git.example/api/v4/projects/grp%2Fsub%2Fwidgets/merge_requests/7', token: TOKEN }]);
  });

  it('knows merged, closed and a request from a fork', async () => {
    expect(await read(gitlab(mr({ state: 'merged', merge_commit_sha: 'e'.repeat(40) })))).toMatchObject({ kind: 'ok', pull: { state: 'closed', merged: true, mergeSha: 'e'.repeat(40) } });
    expect(await read(gitlab(mr({ state: 'merged', merge_commit_sha: null, squash_commit_sha: 'f'.repeat(40) })))).toMatchObject({ pull: { mergeSha: 'f'.repeat(40) } });
    expect(await read(gitlab(mr({ state: 'closed' })))).toMatchObject({ pull: { state: 'closed', merged: false, mergeSha: null } });
    expect(await read(gitlab(mr({ source_project_id: 9 })))).toMatchObject({ pull: { headRepo: 'fork-of:grp/sub/widgets' } });
  });

  it('turns only a 401 into a refused token, and says nothing from the answer', async () => {
    expect(await read(gitlab({}, 401))).toMatchObject({ kind: 'retry', refused: true });
    for (const status of [403, 404, 500]) expect(await read(gitlab({ message: TOKEN }, status))).toMatchObject({ kind: 'retry', why: `status ${status}` });
    expect(await read(gitlab(mr({ state: 'weird' })))).toMatchObject({ kind: 'retry', why: 'unexpected answer' });
  });
});

describe('verifyPullRequest on GitLab', () => {
  const credentials = (identity: boolean): ProjectCredentialsProvider =>
    ({
      id: 'project.credentials',
      read: async () => ({ token: TOKEN, origin: ORIGIN, branch: 'main', ...(identity ? { identity: { provider: 'gitlab', login: 'bot', userId: '5', commitAs: 'bot' } } : {}) }),
      setRefused: async () => undefined,
    }) as unknown as ProjectCredentialsProvider;
  const deps = (body: unknown, identity = true): PullRequestDeps => ({ credentials: () => credentials(identity), originAllow: ['https://git.example/'], fetch: gitlab(body) });
  const ask = (d: PullRequestDeps, extra: Record<string, unknown> = {}) =>
    verifyPullRequest(d, { team: { id: 't', slug: 'eng' }, taskId: TASK, project: 'widgets', testedSha: TESTED, number: 7, ...extra });

  it('accepts a request at the published (squashed) commit and makes the address itself', async () => {
    expect(await ask(deps(mr()), { publishedSha: SQUASHED })).toMatchObject({
      ok: true,
      squashed: true,
      headSha: SQUASHED,
      url: 'https://git.example/grp/sub/widgets/-/merge_requests/7',
    });
  });

  it('refuses a request at some other commit, from another branch, or one that is not open', async () => {
    expect(await ask(deps(mr()))).toMatchObject({ ok: false, code: 'sha_mismatch' });
    expect(await ask(deps(mr({ source_branch: 'card-99999999' })), { publishedSha: SQUASHED })).toMatchObject({ ok: false, code: 'wrong_branch' });
    expect(await ask(deps(mr({ state: 'merged' })), { publishedSha: SQUASHED })).toMatchObject({ ok: false, code: 'not_open' });
    expect(await ask(deps(mr({ source_project_id: 9 })), { publishedSha: SQUASHED })).toMatchObject({ ok: false, code: 'wrong_repository' });
  });

  it('treats a credential without an identity as GitHub’s: a nested GitLab path is no GitHub address', async () => {
    expect(await ask(deps(mr(), false), { publishedSha: SQUASHED })).toMatchObject({ ok: false, code: 'no_credential' });
  });
});
