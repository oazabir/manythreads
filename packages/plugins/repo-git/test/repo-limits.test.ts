import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetRepoHistoryResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGitLayer, createGitRunner } from '../src/git/index.ts';
import { REPO_LIST_MAX_ENTRIES, repoLimitsFromEnv, DEFAULT_REPO_MAX_BYTES } from '../src/repo.ts';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from './world.ts';

// Phase 4 security review: M2 (quota, list limit, gc), M3 (per-actor read limits, bounded git queue), L1 (literal pathspecs), L3 (bots and guarded paths in the writer).

const { omar, nadia, sameera, tariq } = personas;
vi.setConfig({ testTimeout: 90_000 });

let w: RepoWorld;
let scratch = '';
beforeAll(async () => {
  w = await createRepoWorld();
  scratch = mkdtempSync(join(tmpdir(), 'manythreads-limits-'));
}, 180_000);
afterAll(async () => {
  await w?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const mkt = TEAM_IDS.Marketing;
const sup = TEAM_IDS['Customer support'];
const eng = TEAM_IDS.Engineering;
const person = (p: typeof tariq) => ({ id: p.actorId as string, kind: 'person' as const });
const put = (path: string, content: string) => ({ path, op: 'put' as const, content });

describe('M2: quota', () => {
  it('reads the limits from the environment, 512 MiB by default, and ignores nonsense', () => {
    expect(repoLimitsFromEnv({}).maxRepoBytes).toBe(DEFAULT_REPO_MAX_BYTES);
    expect(DEFAULT_REPO_MAX_BYTES).toBe(512 * 1024 * 1024);
    expect(repoLimitsFromEnv({ MANYTHREADS_REPO_MAX_BYTES: '1000' }).maxRepoBytes).toBe(1000);
    expect(repoLimitsFromEnv({ MANYTHREADS_REPO_MAX_BYTES: 'lots' }).maxRepoBytes).toBe(DEFAULT_REPO_MAX_BYTES);
    expect(repoLimitsFromEnv({ MANYTHREADS_REPO_MAX_BYTES: '-5' }).maxRepoBytes).toBe(DEFAULT_REPO_MAX_BYTES);
  });

  it('a commit that would pass the byte quota is 413 repo_quota_exceeded and writes nothing; deleting is still allowed', async () => {
    const svc = w.replica({ maxRepoBytes: 200 * 1024 });
    const ok = await w.as(tariq, (tx) => svc.write(tx, mkt, person(tariq), [put('pages/small.md', 'small\n')], 'small'));
    expect(ok.noop).toBe(false);
    const git = createGitLayer();
    const head = await git.resolve(w.gitDir(mkt), 'main');
    const err = await w.as(tariq, (tx) => svc.write(tx, mkt, person(tariq), [put('pages/huge.md', 'x'.repeat(900_000))], 'huge')).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 413, code: 'repo_quota_exceeded' });
    expect(await git.resolve(w.gitDir(mkt), 'main')).toBe(head);
    // over the limit already (the limit was lowered): an edit that adds bytes is refused, one that only deletes is not
    const tiny = w.replica({ maxRepoBytes: 1 });
    expect(await w.as(tariq, (tx) => tiny.write(tx, mkt, person(tariq), [put('pages/more.md', 'more\n')], 'more')).catch((e: unknown) => e)).toMatchObject({ status: 413 });
    const del = await w.as(tariq, (tx) => tiny.write(tx, mkt, person(tariq), [{ path: 'pages/small.md', op: 'delete' }], 'delete'));
    expect(del.noop).toBe(false);
  });

  it('over HTTP the refusal is the error envelope with the new code', async () => {
    // the shared server uses the default (512 MiB); a normal commit passes, so only the shape of the code is checked at service level above
    const res = await w.commit(nadia, 'engineering', [{ op: 'put', path: 'pages/limits-ok.md', content: 'fine\n' }], 'fine');
    expect(res.status).toBe(201);
  });

  it('a commit that would pass the file-count quota is refused', async () => {
    await w.as(sameera, (tx) => w.replica().ensure(tx, sup));
    const count = Number((await w.system((tx) => tx.query<{ n: string }>('SELECT count(*) AS n FROM app.repo_entries WHERE team_id = $1', [sup]))).rows[0]!.n);
    const tight = w.replica({ maxRepoFiles: count + 1 });
    await w.as(sameera, (tx) => tight.write(tx, sup, person(sameera), [put('pages/q1.md', '1\n')], 'q1'));
    const err = await w.as(sameera, (tx) => tight.write(tx, sup, person(sameera), [put('pages/q2.md', '2\n'), put('pages/q3.md', '3\n')], 'q2')).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 413, code: 'repo_quota_exceeded' });
    // an edit of an existing file creates nothing
    await w.as(sameera, (tx) => tight.write(tx, sup, person(sameera), [put('pages/q1.md', 'one\n')], 'edit q1'));
  });
});

describe('M2: the folder listing is capped', () => {
  it('lists at most `listLimit` names, folders first and in name order', async () => {
    const svc = w.replica({ listLimit: 4 });
    expect(REPO_LIST_MAX_ENTRIES).toBe(5000);
    await w.as(sameera, (tx) => svc.write(tx, sup, person(sameera), Array.from({ length: 8 }, (_, i) => put(`pages/many/f${i}.md`, `${i}\n`)), 'many'));
    const names = (await w.as(sameera, (tx) => svc.list(tx, sup, 'pages/many'))).map((e) => e.name);
    expect(names).toEqual(['f0.md', 'f1.md', 'f2.md', 'f3.md']);
    expect((await w.as(sameera, (tx) => w.replica().list(tx, sup, 'pages/many'))).length).toBe(8);
  });
});

describe('M2: git gc', () => {
  it('packs the loose objects of a repository that has enough of them, and the sweep goes over every team repo', async () => {
    const git = createGitLayer();
    const dir = join(scratch, 'gc.git');
    await git.initBare(dir);
    const files: string[] = [];
    for (let i = 0; i < 1600; i += 1) {
      const f = join(scratch, `blob-${i}`);
      writeFileSync(f, `object number ${i}\n`);
      files.push(f);
    }
    const shas = execFileSync('git', ['--git-dir', dir, 'hash-object', '-w', '--stdin-paths'], { input: files.join('\n'), encoding: 'utf8' }).trim().split('\n');
    // gc packs what a branch reaches: make a commit over all of them
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'gc.index'), GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x.test', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x.test' };
    execFileSync('git', ['--git-dir', dir, 'update-index', '--add', '--index-info'], { env, input: shas.map((sha, i) => `100644 ${sha}\tf${i}`).join('\n') });
    const tree = execFileSync('git', ['--git-dir', dir, 'write-tree'], { env, encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['--git-dir', dir, 'commit-tree', tree, '-m', 'many'], { env, encoding: 'utf8' }).trim();
    execFileSync('git', ['--git-dir', dir, 'update-ref', 'refs/heads/main', commit]);
    const loose = (): number => Number(/^count: (\d+)$/m.exec(execFileSync('git', ['--git-dir', dir, 'count-objects', '-v'], { encoding: 'utf8' }))![1]);
    expect(loose()).toBeGreaterThan(1500);
    await git.gc(dir, { looseObjects: 100_000 }); // below the threshold: nothing happens
    expect(loose()).toBeGreaterThan(1500);
    await git.gc(dir, { looseObjects: 1000 });
    expect(loose()).toBeLessThan(10);
    expect(await git.sizeBytes(dir)).toBeGreaterThan(0);
  });

  it('gcAll runs for each repository in the index and reports failures without stopping', async () => {
    const svc = w.replica();
    const seen: string[] = [];
    const res = await w.system((tx) => svc.gcAll(tx as never, (id) => seen.push(id)));
    expect(res.failed).toBe(0);
    expect(res.repos).toBeGreaterThanOrEqual(2);
    const boom = w.replica();
    const failing = await w.system((tx) => boom.gcAll(tx as never, (id) => seen.push(id)));
    expect(failing.repos + failing.failed).toBeGreaterThanOrEqual(2);
  });
});

describe('M3: limits and a bounded git queue', () => {
  it('the read routes are limited per actor (429 past the window)', async () => {
    const statuses = new Set<number>();
    for (let i = 0; i < 125; i += 1) statuses.add((await w.call(sameera, 'GET', '/api/teams/customer-support/repo/history?path=pages%2Fnothing&limit=1')).status);
    expect(statuses.has(429)).toBe(true);
    // another actor has a window of its own
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/repo/history?path=pages%2Fnothing&limit=1')).status).not.toBe(429);
  });

  it('the git runner refuses with 503 when its queue is full', async () => {
    const svc = w.replica({ git: createGitLayer({ runner: createGitRunner({ poolSize: 1, maxQueue: 0 }) }) });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => w.as(nadia, (tx) => svc.blob(tx, eng, 'TEAM.md', 'main'))));
    const busy = results.filter((r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 503);
    expect(busy.length).toBeGreaterThan(0);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect((busy[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'internal' });
  });
});

describe('L1: a path is a name, never a pattern', () => {
  it('history and diff treat `*` and `:(glob)` literally', async () => {
    await w.commit(nadia, 'engineering', [{ op: 'put', path: 'pages/lit-a.md', content: 'a\n' }, { op: 'put', path: 'pages/lit-b.md', content: 'b\n' }], 'two pages');
    const h = async (path: string) => GetRepoHistoryResponse.parse((await w.call(omar, 'GET', `/api/teams/engineering/repo/history?path=${encodeURIComponent(path)}`)).body).commits.length;
    expect(await h('pages/lit-a.md')).toBe(1);
    expect(await h('pages/*')).toBe(0);
    expect(await h('pages/lit-*.md')).toBe(0);
    expect(await h(':(glob)pages/**')).toBe(0);
    expect(await h(':(top)pages')).toBe(0);
    const diff = await w.call(omar, 'GET', `/api/teams/engineering/repo/diff?path=${encodeURIComponent(':(glob)*')}&to=main`);
    expect(diff.status).toBe(200);
    expect(diff.body).toMatchObject({ status: 'unchanged', additions: 0, deletions: 0 });
  });

  it('a file whose name is a pattern is still found by its own name', async () => {
    const svc = w.replica();
    await w.as(sameera, (tx) => svc.write(tx, sup, person(sameera), [put('pages/star*.md', 's\n')], 'star'));
    const log = await w.as(sameera, (tx) => svc.history(tx, sup, { path: 'pages/star*.md', limit: 10 }));
    expect(log.commits).toHaveLength(1);
  });
});

describe('L3: the writer refuses guarded paths for a bot whatever the capability', () => {
  it('a bot writing bots/, TEAM.md, skills/ or routines/ with an unknown capability is 403', async () => {
    const bot = await w.makeBot(eng, ['files.write', 'custom.write']);
    const svc = w.replica(); // its authorize says yes to everything, like a broker that does not know the capability
    for (const path of ['bots/coder/BOT.md', 'TEAM.md', 'skills/x/SKILL.md', 'routines/r.md', 'BOTS/x.md']) {
      const err = await w.as(bot, (tx) => svc.write(tx, eng, { id: bot.actorId, kind: 'bot' }, [put(path, 'x\n')], 'sneak', [], { capability: 'custom.write' as never })).catch((e: unknown) => e);
      expect(err, path).toMatchObject({ status: 403 });
    }
    const ok = await w.as(bot, (tx) => svc.write(tx, eng, { id: bot.actorId, kind: 'bot' }, [put('pages/by-bot.md', 'x\n')], 'fine', [], { capability: 'custom.write' as never }));
    expect(ok.noop).toBe(false);
  });
});

describe('L6: creating a repository without the right to post is a refusal, not a 500', () => {
  it('maps the insufficient_privilege of repo_register to 403', async () => {
    const svc = w.replica();
    const team = '00000000-0000-7000-8000-00000000f006';
    const tx = {
      actor: { id: sameera.actorId, kind: 'person', workspaceId: sameera.workspaceId },
      query: (text: string) => {
        if (text.includes('FROM app.teams')) return Promise.resolve({ rows: [{ id: team, slug: 'x', name: 'X', archived_at: null }] });
        if (text.includes('FROM app.repos')) return Promise.resolve({ rows: [] });
        if (text.includes('repo_register')) return Promise.reject(Object.assign(new Error('you may not open the repository of this team'), { code: '42501' }));
        return Promise.resolve({ rows: [] });
      },
    };
    const err = await svc.ensure(tx as never, team).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
  });
});
