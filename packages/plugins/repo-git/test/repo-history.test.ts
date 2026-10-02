import { execFileSync } from 'node:child_process';
import { CommitRepoResponse, GetRepoDiffResponse, GetRepoHistoryResponse, RestoreRepoFileResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from './world.ts';

// History, diff, restore and the content route (PLAN P4-08, criteria 7 and 9): per-path history with authors, unified hunks, restore as a NEW commit (the old
// ones stay), the writer rules apply to a restore, and the bytes of a repo file with the right type for a URL.

const { omar, nadia, priya, sameera, lena } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const put = (path: string, content: string, extra: Record<string, unknown> = {}) => ({ op: 'put', path, content, ...extra });
const q = (path: string, extra = ''): string => `path=${encodeURIComponent(path)}${extra}`;
const history = (who: typeof omar | null, path: string, extra = '') => w.call(who, 'GET', `/api/teams/engineering/repo/history?${q(path, extra)}`);
const diff = (who: typeof omar | null, path: string, extra = '') => w.call(who, 'GET', `/api/teams/engineering/repo/diff?${q(path, extra)}`);
const restore = (who: typeof omar | null, path: string, sha: string, extra: Record<string, unknown> = {}) =>
  w.call(who, 'POST', '/api/teams/engineering/repo/restore', { path, sha, ...extra });
const mustCommit = async (who: typeof omar, changes: unknown[], message: string): Promise<string> => {
  const res = await w.commit(who, 'engineering', changes, message);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CommitRepoResponse.parse(res.body).sha;
};
const raw = async (who: typeof omar | null, slug: string, query: string) => {
  const res = await fetch(`${w.server.url}/api/teams/${slug}/repo/content?${query}`, {
    headers: who ? { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) } : {},
  });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
};

const PAGE = 'pages/runbook.md';
let c1 = '';
let c2 = '';
let c3 = '';

describe('history of a path', () => {
  it('lists the commits that touched a file, newest first, with author, co-author slot and what each did', async () => {
    c1 = await mustCommit(nadia, [put(PAGE, '# Runbook\n\nstep one\nstep two\n'), put('pages/other.md', 'x\n')], 'Add the runbook');
    c2 = await mustCommit(priya, [put(PAGE, '# Runbook\n\nstep one\nstep 2\nstep three\n')], 'Edit the runbook');
    await mustCommit(omar, [put('pages/unrelated.md', 'y\n')], 'Unrelated');
    c3 = await mustCommit(nadia, [{ op: 'delete', path: PAGE }], 'Remove the runbook');
    const res = await history(omar, PAGE);
    expect(res.status).toBe(200);
    const page = GetRepoHistoryResponse.parse(res.body);
    expect(page.path).toBe(PAGE);
    expect(page.nextCursor).toBeNull();
    expect(page.commits.map((c) => [c.sha, c.subject, c.authorId, c.authorName, c.change])).toEqual([
      [c3, 'Remove the runbook', nadia.actorId, 'Nadia', 'deleted'],
      [c2, 'Edit the runbook', priya.actorId, 'Priya', 'modified'],
      [c1, 'Add the runbook', nadia.actorId, 'Nadia', 'added'],
    ]);
    expect(page.commits[1]!.parentSha).toBe(c1);
  });

  it('a folder collects every commit below it (no per-file change), the repo root every commit including the system’s first', async () => {
    const folder = GetRepoHistoryResponse.parse((await history(omar, 'pages')).body);
    expect(folder.commits.map((c) => c.subject)).toEqual(['Remove the runbook', 'Unrelated', 'Edit the runbook', 'Add the runbook', 'Create the team repository']);
    expect(folder.commits.every((c) => c.change === null)).toBe(true);
    const all = GetRepoHistoryResponse.parse((await history(omar, '')).body);
    const first = all.commits[all.commits.length - 1]!;
    expect(first).toMatchObject({ subject: 'Create the team repository', authorId: null, parentSha: null });
  });

  it('pages with a cursor', async () => {
    const one = GetRepoHistoryResponse.parse((await history(omar, '', '&limit=2')).body);
    expect(one.commits).toHaveLength(2);
    expect(one.nextCursor).toBe(one.commits[1]!.sha);
    const two = GetRepoHistoryResponse.parse((await history(omar, '', `&limit=2&cursor=${one.nextCursor}`)).body);
    expect(two.commits[0]!.sha).toBe(one.commits[1]!.parentSha);
    expect(two.commits.map((c) => c.sha)).not.toContain(one.commits[0]!.sha);
  });

  it('is readable by team members only: Sameera of another team and Lena get 403, no caller 401, a bad path 400', async () => {
    expect((await history(sameera, PAGE)).status).toBe(403);
    expect((await history(lena, PAGE)).status).toBe(403);
    expect((await history(null, PAGE)).status).toBe(401);
    expect((await history(omar, '../x')).status).toBe(400);
    expect((await history(omar, PAGE, '&limit=0')).status).toBe(400);
    expect((await history(omar, PAGE, '&cursor=main')).status).toBe(400);
  });
});

describe('diff', () => {
  it('shows what one commit changed: hunks with line numbers on both sides', async () => {
    const res = await diff(omar, PAGE, `&to=${c2}`);
    expect(res.status).toBe(200);
    const d = GetRepoDiffResponse.parse(res.body);
    expect(d).toMatchObject({ path: PAGE, fromCommitSha: c1, toCommitSha: c2, status: 'modified', binary: false, additions: 2, deletions: 1, truncated: false });
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]!.lines.map((l) => `${l.type}:${l.oldLine ?? '-'}:${l.newLine ?? '-'}:${l.text}`)).toEqual([
      'context:1:1:# Runbook',
      'context:2:2:',
      'context:3:3:step one',
      'del:4:-:step two',
      'add:-:4:step 2',
      'add:-:5:step three',
    ]);
  });

  it('between two commits, for a file added (first commit) and one removed', async () => {
    const added = GetRepoDiffResponse.parse((await diff(omar, PAGE, `&to=${c1}`)).body);
    expect(added).toMatchObject({ status: 'added', fromCommitSha: expect.any(String), additions: 4, deletions: 0 });
    const fromStart = GetRepoDiffResponse.parse((await diff(omar, PAGE, `&from=${c1}&to=${c3}`)).body);
    expect(fromStart).toMatchObject({ status: 'deleted', additions: 0, deletions: 4 });
    const none = GetRepoDiffResponse.parse((await diff(omar, 'pages/other.md', `&from=${c1}&to=${c3}`)).body);
    expect(none).toMatchObject({ status: 'unchanged', hunks: [], additions: 0, deletions: 0 });
  });

  it('the first commit of the repository diffs against nothing', async () => {
    const all = GetRepoHistoryResponse.parse((await history(omar, '')).body);
    const firstSha = all.commits[all.commits.length - 1]!.sha;
    const res = await diff(omar, 'TEAM.md', `&to=${firstSha}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = GetRepoDiffResponse.parse(res.body);
    expect(d).toMatchObject({ status: 'added', fromCommitSha: null });
    expect(d.additions).toBeGreaterThan(3);
  });

  it('refuses outsiders, unknown commits and bad refs', async () => {
    expect((await diff(sameera, PAGE, `&to=${c2}`)).status).toBe(403);
    expect((await diff(omar, PAGE, `&to=${'0'.repeat(40)}`)).status).toBe(404);
    expect((await diff(omar, PAGE, '&to=refs/heads/x')).status).toBe(400);
    expect((await diff(omar, PAGE, '&from=--output=/tmp/x')).status).toBe(400);
  });
});

describe('restore is a new commit (criterion 7)', () => {
  it('puts the file back as it was at the first commit; the old commits stay; the restorer is the author', async () => {
    const before = GetRepoHistoryResponse.parse((await history(omar, '')).body).commits.length;
    const res = await restore(nadia, PAGE, c1);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const done = RestoreRepoFileResponse.parse(res.body);
    expect(done).toMatchObject({ noop: false, authorId: nadia.actorId, restoredFromSha: c1 });
    expect(done.paths).toEqual([{ path: PAGE, op: 'put', blobSha: expect.any(String), size: 29 }]);
    const after = GetRepoHistoryResponse.parse((await history(omar, '')).body);
    expect(after.commits).toHaveLength(before + 1);
    expect(after.commits[0]).toMatchObject({ sha: done.sha, subject: `Restore ${PAGE} to ${c1.slice(0, 7)}`, change: null });
    expect(after.commits.map((c) => c.sha)).toEqual(expect.arrayContaining([c1, c2, c3]));
    const content = await raw(omar, 'engineering', q(PAGE));
    expect(content.bytes.toString()).toBe('# Runbook\n\nstep one\nstep two\n');
    // the page's history now reads: restore (added again), delete, edit, create
    const page = GetRepoHistoryResponse.parse((await history(omar, PAGE)).body);
    expect(page.commits.map((c) => c.change)).toEqual(['added', 'deleted', 'modified', 'added']);
  });

  it('restoring what the file already is is a no-op (200, no commit); restoring to a time it did not exist deletes it', async () => {
    const same = await restore(nadia, PAGE, c1);
    expect(same.status).toBe(200);
    expect(RestoreRepoFileResponse.parse(same.body).noop).toBe(true);
    const firstSha = GetRepoHistoryResponse.parse((await history(omar, '')).body).commits.at(-1)!.sha;
    const gone = await restore(nadia, PAGE, firstSha, { message: 'Take the runbook out again' });
    expect(gone.status).toBe(201);
    expect(RestoreRepoFileResponse.parse(gone.body).paths).toEqual([{ path: PAGE, op: 'delete', blobSha: null, size: null }]);
    expect((await raw(omar, 'engineering', q(PAGE))).status).toBe(404);
    const latest = GetRepoHistoryResponse.parse((await history(omar, '')).body).commits[0]!;
    expect(latest.subject).toBe('Take the runbook out again');
  });

  it('the writer rules apply: Priya cannot restore bots/ or TEAM.md (403, change by pull request); Omar can; outsiders 403; unknown commit 404', async () => {
    const teamMdAtStart = GetRepoHistoryResponse.parse((await history(omar, 'TEAM.md')).body).commits.at(-1)!.sha;
    await mustCommit(omar, [put('TEAM.md', '---\nname: Engineering\n---\nchanged\n')], 'Lead edits TEAM.md');
    const denied = await restore(priya, 'TEAM.md', teamMdAtStart);
    expect(denied.status).toBe(403);
    expect((denied.body as { error: { message: string } }).error.message).toMatch(/pull request/i);
    expect((await restore(sameera, 'TEAM.md', teamMdAtStart)).status).toBe(403);
    expect((await restore(lena, PAGE, c1)).status).toBe(403);
    expect((await restore(null, PAGE, c1)).status).toBe(401);
    expect((await restore(omar, PAGE, '0'.repeat(40))).status).toBe(404);
    const ok = await restore(omar, 'TEAM.md', teamMdAtStart);
    expect(ok.status).toBe(201);
    expect(RestoreRepoFileResponse.parse(ok.body).authorId).toBe(omar.actorId);
    // strict body
    expect((await restore(omar, PAGE, c1, { extra: true })).status).toBe(400);
    expect((await restore(omar, PAGE, 'main')).status).toBe(400);
  });

  it('a version at a commit is readable through the blob route (for a rendered diff made by the client)', async () => {
    const old = await w.call<{ content: string }>(omar, 'GET', `/api/teams/engineering/repo/blob?${q(PAGE, `&ref=${c2}`)}`);
    expect(old.status).toBe(200);
    expect(old.body.content).toBe('# Runbook\n\nstep one\nstep 2\nstep three\n');
  });
});

describe('content: the bytes of a repo file for a URL', () => {
  it('serves text with its type, nosniff and a sandbox, private and revalidated', async () => {
    await mustCommit(nadia, [put('pages/notes.md', '# Notes\n'), put('pages/data.csv', 'a,b\n1,2\n')], 'Add notes');
    const md = await raw(omar, 'engineering', q('pages/notes.md'));
    expect(md.status).toBe(200);
    expect(md.bytes.toString()).toBe('# Notes\n');
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('x-content-type-options')).toBe('nosniff');
    expect(md.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(md.headers.get('cache-control')).toBe('private, no-cache');
    expect(md.headers.get('content-disposition')).toMatch(/^inline; filename="notes\.md"/);
    const csv = await raw(omar, 'engineering', q('pages/data.csv', '&download=1'));
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toMatch(/^attachment; filename="data\.csv"/);
  });

  it('an SVG is an image/svg+xml under a sandbox (it renders in <img>); HTML and scripts are opaque bytes', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script><rect width="4" height="4"/></svg>';
    await mustCommit(nadia, [put('pages/logo.svg', svg), put('pages/page.html', '<script>alert(1)</script>'), put('pages/run.js', 'alert(1)')], 'Add assets');
    const s = await raw(omar, 'engineering', q('pages/logo.svg'));
    expect(s.headers.get('content-type')).toBe('image/svg+xml');
    expect(s.headers.get('content-security-policy')).toMatch(/default-src 'none'.*sandbox/);
    expect(s.bytes.toString()).toBe(svg);
    for (const p of ['pages/page.html', 'pages/run.js']) {
      const r = await raw(omar, 'engineering', q(p));
      expect(r.headers.get('content-type'), p).toBe('application/octet-stream');
      expect(r.headers.get('content-disposition'), p).toMatch(/^attachment/);
    }
  });

  it('reads at a commit, and refuses outsiders, missing files, folders and bad paths', async () => {
    const old = await raw(omar, 'engineering', q(PAGE, `&ref=${c2}`));
    expect(old.status).toBe(200);
    expect(old.bytes.toString()).toBe('# Runbook\n\nstep one\nstep 2\nstep three\n');
    expect((await raw(sameera, 'engineering', q('pages/notes.md'))).status).toBe(403);
    expect((await raw(lena, 'engineering', q('pages/notes.md'))).status).toBe(403);
    expect((await raw(null, 'engineering', q('pages/notes.md'))).status).toBe(401);
    expect((await raw(omar, 'engineering', q('pages/nothing.md'))).status).toBe(404);
    expect((await raw(omar, 'engineering', q('pages'))).status).toBe(400);
    expect((await raw(omar, 'engineering', q('pages/../TEAM.md'))).status).toBe(400);
  });
});

describe('channels/ is reserved for attachments', () => {
  it('a commit under channels/ is refused: the Files tree would show channel attachments there', async () => {
    const res = await w.commit(nadia, 'engineering', [put('channels/dev/readme.md', 'x')], 'sneaky');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/reserved/);
    const upper = await w.commit(nadia, 'engineering', [put('Channels/x.md', 'x')], 'sneaky');
    expect(upper.status).toBe(400);
  });
});

// M1 of the Phase 4 security review: a trailer typed into a message states nothing, and a malformed trailer already in git never breaks History.
describe('co-author trailers', () => {
  const ACTORS = '@actors.manythreads.invalid';
  const gitIn = (dir: string, args: string[], input?: string): string =>
    execFileSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: `${nadia.actorId}${ACTORS}`, GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.test' } }).trim();
  /** A commit made behind the writer's back, exactly as a pre-fix forged message (or a pushed commit) would be. */
  const poisoned = (message: string): string => {
    const dir = w.gitDir(TEAM_IDS.Engineering);
    const head = gitIn(dir, ['rev-parse', 'main']);
    const sha = gitIn(dir, ['commit-tree', `${head}^{tree}`, '-p', head, '-F', '-'], message);
    gitIn(dir, ['update-ref', 'refs/heads/main', sha, head]);
    return sha;
  };

  it('a trailer typed into the message is not a co-author, and shows in History as plain quoted text', async () => {
    const forged = `Edit\n\nCo-authored-by: Omar <${omar.actorId}${ACTORS}>\n  co-authored-by: Omar <${omar.actorId}${ACTORS}>\r\nCO-AUTHORED-BY: Omar <${omar.actorId}${ACTORS}>`;
    const sha = await mustCommit(nadia, [put('pages/forge.md', 'x\n')], forged);
    const page = GetRepoHistoryResponse.parse((await history(omar, '')).body);
    const c = page.commits.find((x) => x.sha === sha)!;
    expect(c.coAuthorIds).toEqual([]);
    expect(c.message).not.toMatch(/^\s*co-authored-by:/im);
    expect(c.message.match(/^> Co-authored-by:/gim)).toHaveLength(3);
  });

  it('the trailers the writer builds come from the validated argument: valid ids only, no names with line breaks', async () => {
    const svc = w.replica();
    const res = await w.as(nadia, (tx) =>
      svc.write(tx, TEAM_IDS.Engineering, { id: nadia.actorId, kind: 'person' }, [{ path: 'pages/co.md', op: 'put', content: 'x\n' }], 'Co edit', [
        { actorId: priya.actorId, name: 'Priya' },
        { actorId: '11111111-1111-1111-1111-111111111111', name: 'Not an actor' },
        { actorId: omar.actorId, name: 'Omar\nCo-authored-by: Mallory <m@x.test>' },
      ]),
    );
    const page = GetRepoHistoryResponse.parse((await history(omar, '')).body);
    expect(page.commits.find((x) => x.sha === res.sha)?.coAuthorIds).toEqual([priya.actorId]);
    expect(page.commits.find((x) => x.sha === res.sha)?.message).not.toMatch(/Mallory/);
  });

  it('a malformed trailer in an existing commit does not break History, and the next write still indexes it', async () => {
    const bad = poisoned(`Pushed\n\nCo-authored-by: Ghost <11111111-1111-1111-1111-111111111111${ACTORS}>\nCo-authored-by: Dash <${'-'.repeat(36)}${ACTORS}>\nCo-authored-by: Real <${priya.actorId}${ACTORS}>`);
    const res = await history(omar, '');
    expect(res.status).toBe(200);
    const page = GetRepoHistoryResponse.parse(res.body);
    expect(page.commits[0]?.sha).toBe(bad);
    expect(page.commits[0]?.coAuthorIds).toEqual([priya.actorId]);
    // git is ahead of the index: the next write catches it up (a `-`-filled id used to raise 22P02 in the index function and wedge every write)
    const next = await w.commit(nadia, 'engineering', [put('pages/after-poison.md', 'x\n')], 'After the poison');
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const after = GetRepoHistoryResponse.parse((await history(omar, '')).body);
    expect(after.commits.find((x) => x.sha === bad)?.coAuthorIds).toEqual([priya.actorId]);
  });
});
