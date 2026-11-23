import type { PluginContext, PluginTx, ProjectCredentialsProvider } from '@manythreads/sdk';
import { parseGitRepo } from '@manythreads/shared';
import { startFakeGithub, type FakeGithub } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRequestChecks, listRequestFiles, MAX_PAGE_PATCH_BYTES, MAX_PATCH_BYTES, summarize, type ProviderTarget } from '../src/review.ts';
import { registerReviewRoutes } from '../src/review-routes.ts';
import type { PullRequestDeps } from '../src/pull-requests.ts';

// P35-02 steps 1 and 2: the card's Review reads the pull request's files and the head's checks through the server, with the project's token. GitHub is the
// local double (real HTTP); GitLab is a fake fetch. The route is driven through a stub context, the database answering by SQL.

const TOKEN = 'ghp_ReviewTestToken0123456789abcdefgh'; // secret-scan:ignore (a fake token of the local GitHub double)
const ORIGIN = 'https://github.com/acme/widgets';
const HEAD = 'a'.repeat(40);
const TEAM = '01a16e30-0000-7000-8000-0000000000c2';
const TASK = '01a16e30-0000-7000-8000-0000000000b1';

let gh: FakeGithub;
let target: ProviderTarget;
beforeAll(async () => {
  gh = await startFakeGithub({ token: TOKEN, owner: 'acme', repo: 'widgets' });
  target = { repo: parseGitRepo(ORIGIN, 'github')!, token: TOKEN, apiBase: gh.url };
});
afterAll(() => gh.stop());

async function openPull(files: unknown[]): Promise<number> {
  const r = await fetch(`${gh.url}/repos/acme/widgets/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 't', head: 'card-01a16e30', base: 'main', head_sha: HEAD }),
  });
  const n = ((await r.json()) as { number: number }).number;
  gh.pulls.get(n)!.files = files;
  return n;
}

const file = (name: string, over: Record<string, unknown> = {}) => ({ filename: name, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b', ...over });

describe('the files of a pull request', () => {
  it('names added, deleted, renamed and binary files, keeps a too-large file as truncated, and pages by the Link header', async () => {
    const many = Array.from({ length: 31 }, (_, i) => file(`src/f${i}.ts`));
    many[0] = file('src/new.ts', { status: 'added', additions: 2, deletions: 0, patch: '@@ -0,0 +1,2 @@\n+x\n+y' });
    many[1] = file('src/old.ts', { status: 'removed', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-x' });
    many[2] = file('src/moved.ts', { status: 'renamed', previous_filename: 'src/was.ts', additions: 0, deletions: 0, patch: undefined });
    many[3] = file('logo.png', { additions: 0, deletions: 0, patch: undefined });
    many[4] = file('big.json', { additions: 9000, deletions: 0, patch: undefined });
    const n = await openPull(many);
    const p1 = await listRequestFiles(target, n, 1);
    expect(p1).toMatchObject({ ok: true, nextPage: 2 });
    if (!p1.ok) return;
    expect(p1.files).toHaveLength(30);
    expect(p1.files[0]).toMatchObject({ path: 'src/new.ts', status: 'added', additions: 2, binary: false });
    expect(p1.files[1]).toMatchObject({ status: 'deleted' });
    expect(p1.files[2]).toMatchObject({ status: 'renamed', previousPath: 'src/was.ts', binary: false, patch: null });
    expect(p1.files[3]).toMatchObject({ path: 'logo.png', binary: true, patch: null });
    expect(p1.files[4]).toMatchObject({ path: 'big.json', binary: false, truncated: true, patch: null });
    const p2 = await listRequestFiles(target, n, 2);
    expect(p2).toMatchObject({ ok: true, nextPage: null });
    if (p2.ok) expect(p2.files.map((f) => f.path)).toEqual(['src/f30.ts']);
  });

  it('leaves out a patch over its own cap and the patches past the page cap, keeping the names', async () => {
    const body = (kb: number) => `@@ -1 +1 @@\n+${'x'.repeat(kb * 1024)}`;
    const n = await openPull([file('huge.ts', { patch: body(70) }), ...Array.from({ length: 5 }, (_, i) => file(`mid${i}.ts`, { patch: body(60) }))]);
    const r = await listRequestFiles(target, n, 1);
    if (!r.ok) throw new Error(r.why);
    expect(r.files[0]).toMatchObject({ path: 'huge.ts', truncated: true, patch: null });
    const kept = r.files.filter((f) => f.patch !== null);
    expect(kept.length).toBe(Math.floor(MAX_PAGE_PATCH_BYTES / (60 * 1024 + 14)));
    expect(r.files.slice(1 + kept.length).every((f) => f.truncated && f.patch === null)).toBe(true);
    expect(MAX_PATCH_BYTES).toBe(64 * 1024);
  });

  it('says a refused token is refused and never puts the token or the answer body in its words', async () => {
    const r = await listRequestFiles({ ...target, token: 'ghp_wrong' }, 1, 1);
    expect(r).toMatchObject({ ok: false, status: 401, refused: true });
    expect(JSON.stringify(r)).not.toContain('ghp_');
    expect(JSON.stringify(r)).not.toContain('Bad credentials');
  });

  it('reads GitLab diffs: counts the lines, names renamed, binary and too large files, pages by x-next-page', async () => {
    const asked: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      asked.push(url);
      expect((init.headers as Record<string, string>)['private-token']).toBe('glpat-x');
      return new Response(
        JSON.stringify([
          { old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1,2 +1,2 @@\n-a\n+b\n+c\n' },
          { old_path: 'was.ts', new_path: 'now.ts', renamed_file: true, diff: '' },
          { old_path: 'img.png', new_path: 'img.png', diff: 'Binary files a/img.png and b/img.png differ\n' },
          { old_path: 'gen.lock', new_path: 'gen.lock', too_large: true, diff: '' },
        ]),
        { status: 200, headers: { 'x-next-page': '2' } },
      );
    }) as unknown as typeof fetch;
    const gl: ProviderTarget = { repo: parseGitRepo('https://gitlab.example.test/grp/sub/app', 'gitlab')!, token: 'glpat-x', apiBase: 'https://gitlab.example.test/api/v4', fetch: fakeFetch };
    const r = await listRequestFiles(gl, 7, 1);
    if (!r.ok) throw new Error(r.why);
    expect(asked[0]).toBe('https://gitlab.example.test/api/v4/projects/grp%2Fsub%2Fapp/merge_requests/7/diffs?per_page=30&page=1');
    expect(r.nextPage).toBe(2);
    expect(r.files[0]).toMatchObject({ path: 'a.ts', additions: 2, deletions: 1, patch: '@@ -1,2 +1,2 @@\n-a\n+b\n+c' });
    expect(r.files[1]).toMatchObject({ status: 'renamed', previousPath: 'was.ts', patch: null, binary: false });
    expect(r.files[2]).toMatchObject({ binary: true, patch: null });
    expect(r.files[3]).toMatchObject({ truncated: true, patch: null });
  });
});

describe('the checks of the head', () => {
  it('merges check runs and commit statuses into one list with a summary, and keeps https links only', async () => {
    gh.checks.set(HEAD, {
      runs: [
        { name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/widgets/runs/1' },
        { name: 'lint', status: 'in_progress', conclusion: null, html_url: 'javascript:alert(1)' },
        { name: 'docs', status: 'completed', conclusion: 'skipped' },
      ],
      statuses: [{ context: 'ci/deploy', state: 'failure', target_url: 'https://ci.example.test/1' }],
    });
    const r = await listRequestChecks(target, 1, HEAD);
    if (!r.ok) throw new Error(r.why);
    expect(r.checks).toEqual([
      { name: 'test', state: 'passing', link: 'https://github.com/acme/widgets/runs/1' },
      { name: 'lint', state: 'pending', link: null },
      { name: 'docs', state: 'skipped', link: null },
      { name: 'ci/deploy', state: 'failing', link: 'https://ci.example.test/1' },
    ]);
    expect(summarize(r.checks)).toBe('failing');
    expect(summarize(r.checks.slice(0, 1))).toBe('passing');
    expect(summarize(r.checks.slice(0, 2))).toBe('pending');
    expect(summarize([])).toBe('none');
  });

  it('says in words which permission is missing when the token may not read checks', async () => {
    const sha = 'b'.repeat(40);
    gh.checks.set(sha, { runs: [], statuses: [], status: 403 });
    expect(await listRequestChecks(target, 1, sha)).toMatchObject({ ok: true, checks: [], unreadable: expect.stringContaining('Checks and Commit statuses') });
  });

  it('takes the GitLab pipeline of the head commit', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify([{ id: 9, sha: 'c'.repeat(40), status: 'success' }, { id: 8, sha: HEAD, status: 'failed', web_url: 'https://gitlab.example.test/p/8' }]), { status: 200 })) as unknown as typeof fetch;
    const gl: ProviderTarget = { repo: parseGitRepo('https://gitlab.example.test/grp/app', 'gitlab')!, token: 'glpat-x', apiBase: 'https://gitlab.example.test/api/v4', fetch: fakeFetch };
    expect(await listRequestChecks(gl, 7, HEAD)).toEqual({ ok: true, checks: [{ name: 'Pipeline #8', state: 'failing', link: 'https://gitlab.example.test/p/8' }], unreadable: null });
  });
});

describe('the review routes', () => {
  function harness(pr: Record<string, unknown> | null, credential: { token: string; origin: string; branch: string; refused?: boolean } | null = { token: TOKEN, origin: ORIGIN, branch: 'main' }) {
    const routes = new Map<string, { handler: (req: unknown) => Promise<{ status: number; body: unknown }> }>();
    const refused: string[] = [];
    const query = (text: string) => {
      if (text.includes('FROM app.teams WHERE slug')) return Promise.resolve({ rows: [{ id: TEAM, workspace_id: 'w', archived_at: null }] });
      if (text.includes('pull_request_head_sha AS head_sha')) return Promise.resolve({ rows: pr ? [{ team_slug: 'engineering', ...pr }] : [] });
      return Promise.resolve({ rows: [] });
    };
    const tx = { actor: { id: 'p', kind: 'person', workspaceId: 'w' }, query } as unknown as PluginTx;
    const credentials = { id: 'project.credentials', read: async () => credential, setRefused: async (_t: unknown, p: string) => void refused.push(p) } as unknown as ProjectCredentialsProvider;
    const deps: PullRequestDeps = { credentials: () => credentials, originAllow: ['https://github.com/acme/'], apiBaseOverride: gh.url };
    const ctx = { http: { route: (r: { path: string; handler: never }) => routes.set(r.path, r) }, db: { as: (_c: unknown, fn: (t: PluginTx) => unknown) => fn(tx) } } as unknown as PluginContext;
    registerReviewRoutes(ctx, () => deps);
    const call = async (path: string, query: Record<string, string> = {}) => {
      const r = routes.get(path)!;
      try {
        return await (r.handler as unknown as (q: unknown, t: PluginTx) => Promise<{ status: number; body: unknown }>)({ params: { slug: "engineering", taskId: TASK }, query, body: undefined }, tx);
      } catch (e) {
        return { status: (e as { status?: number }).status ?? 500, body: { message: (e as Error).message } };
      }
    };
    return { call, refused };
  }

  it('answers the files of the recorded request and says when the request is no longer at the tested head', async () => {
    const n = await openPull([file('src/a.ts')]);
    const h = harness({ number: n, project: 'widgets', origin: ORIGIN, head_sha: HEAD, state: 'open' });
    const r = await h.call('/api/teams/:slug/tasks/:taskId/pull-request/diff');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ number: n, url: `${ORIGIN}/pull/${n}`, atRecordedHead: true, files: [{ path: 'src/a.ts' }] });
    gh.pulls.get(n)!.headSha = 'f'.repeat(40);
    expect((await h.call('/api/teams/:slug/tasks/:taskId/pull-request/diff')).body).toMatchObject({ atRecordedHead: false, headSha: 'f'.repeat(40) });
    expect((await h.call('/api/teams/:slug/tasks/:taskId/pull-request/diff', { page: '0' })).status).toBe(400);
  });

  it('refuses a card without a request, a token for another address, and marks a refused token', async () => {
    expect((await harness(null).call('/api/teams/:slug/tasks/:taskId/pull-request/checks')).status).toBe(404);
    const moved = harness({ number: 1, project: 'widgets', origin: ORIGIN, head_sha: HEAD, state: 'open' }, { token: TOKEN, origin: 'https://github.com/acme/other', branch: 'main' });
    expect((await moved.call('/api/teams/:slug/tasks/:taskId/pull-request/checks')).status).toBe(409);
    const bad = harness({ number: 1, project: 'widgets', origin: ORIGIN, head_sha: HEAD, state: 'open' }, { token: 'ghp_wrong', origin: ORIGIN, branch: 'main' });
    const r = await bad.call('/api/teams/:slug/tasks/:taskId/pull-request/checks');
    expect(r.status).toBe(409);
    expect(bad.refused).toEqual(['widgets']);
    expect(JSON.stringify(r.body)).not.toContain('ghp_');
  });
});
