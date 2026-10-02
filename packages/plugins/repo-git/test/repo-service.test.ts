import { randomUUID } from 'node:crypto';
import { RepoRepoCommittedEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RepoError } from '../src/errors.ts';
import { createGitLayer } from '../src/git/index.ts';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from './world.ts';

// The writer without HTTP: author and co-authors, the lock across replicas, catching the index up after a rolled-back transaction, the 1 MB rule,
// restore. Customer support is the team (Sameera is a member, Priya is not on it).

const { sameera, rafi, tariq } = personas;
const sup = TEAM_IDS['Customer support'];
const git = createGitLayer();

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const person = (p: typeof sameera) => ({ id: p.actorId as string, kind: 'person' as const });
const history = async (teamId: string) => (await git.log(w.gitDir(teamId), { limit: 500 })).commits;
const text = (s: string) => ({ content: s });

describe('commits', () => {
  it('the actor is the author, co-authors become trailers and index ids, the event carries both', async () => {
    const svc = w.replica();
    const res = await w.as(sameera, (tx) =>
      svc.write(tx, sup, person(sameera), [{ path: 'pages/policy.md', op: 'put', ...text('# Policy\n') }], 'Draft the policy', [
        { actorId: personas.tariq.actorId, name: 'Tariq' },
        { actorId: sameera.actorId, name: 'Sameera again' }, // the author is never also a co-author
        { actorId: personas.tariq.actorId, name: 'Tariq twice' }, // nor twice
      ]),
    );
    expect(res).toMatchObject({ noop: false, authorId: sameera.actorId });
    const [c] = await history(sup);
    expect(c).toMatchObject({ sha: res.sha, subject: 'Draft the policy', author: { name: 'Sameera', email: `${sameera.actorId}@actors.manythreads.invalid` } });
    expect(c?.message).toMatch(/\n\nCo-authored-by: Tariq <[0-9a-f-]{36}@actors\.manythreads\.invalid>$/);
    expect(c?.coAuthors).toHaveLength(1);

    const rows = await w.as(sameera, (tx) => svc.index.commits(tx, sup, 10));
    expect(rows[0]).toMatchObject({ sha: res.sha, authorId: sameera.actorId, coAuthors: [tariq.actorId], paths: ['pages/policy.md'], parentSha: res.parentSha });
    const entry = (await w.as(sameera, (tx) => svc.index.entries(tx, sup, 'pages/'))).find((e) => e.path === 'pages/policy.md');
    expect(entry).toMatchObject({ kind: 'file', size: 9, textPlain: '# Policy\n', lastCommitSha: res.sha });

    const event = await w.system(async (tx) =>
      (await tx.query<{ payload: unknown; schema_version: number; workspace_id: string; actor_id: string }>(
        "SELECT payload, schema_version, workspace_id, actor_id FROM app.events WHERE type = 'repo.repo.committed' AND team_id = $1 ORDER BY id DESC LIMIT 1",
        [sup],
      )).rows[0],
    );
    expect(event?.actor_id).toBe(sameera.actorId);
    expect(RepoRepoCommittedEvent.parse({ ...(event?.payload as object), type: 'repo.repo.committed', schemaVersion: 1, workspaceId: event?.workspace_id })).toMatchObject({
      sha: res.sha,
      authorId: sameera.actorId,
      coAuthorIds: [tariq.actorId],
      subject: 'Draft the policy',
      paths: [{ path: 'pages/policy.md', op: 'put' }],
    });
  });

  it('the author cannot be another actor than the transaction’s', async () => {
    const svc = w.replica();
    const before = (await history(sup)).length;
    const err = await w.as(sameera, (tx) => svc.write(tx, sup, person(rafi), [{ path: 'pages/forged.md', op: 'put', ...text('x') }], 'forged')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
    expect((err as RepoError).status).toBe(403);
    const asBot = await w.as(sameera, (tx) => svc.write(tx, sup, { id: sameera.actorId, kind: 'bot' }, [{ path: 'pages/forged.md', op: 'put', ...text('x') }], 'forged')).catch((e: unknown) => e);
    expect((asBot as RepoError).status).toBe(403);
    expect(await history(sup)).toHaveLength(before);
  });

  it('1 MB is the limit: exactly 1,048,576 bytes is stored, one more is an attachment', async () => {
    const svc = w.replica();
    const ok = await w.as(sameera, (tx) => svc.write(tx, sup, person(sameera), [{ path: 'pages/big.md', op: 'put', content: Buffer.alloc(1_048_576, 97) }], 'big'));
    expect(ok.noop).toBe(false);
    const before = (await history(sup)).length;
    const err = await w
      .as(sameera, (tx) => svc.write(tx, sup, person(sameera), [{ path: 'pages/huge.md', op: 'put', content: Buffer.alloc(1_048_577, 97) }], 'huge'))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'attachment_not_in_repo' });
    // an append that would cross the line is refused too, and nothing changes
    const grow = await w.as(sameera, (tx) => svc.write(tx, sup, person(sameera), [{ path: 'pages/big.md', op: 'append', content: 'x' }], 'grow')).catch((e: unknown) => e);
    expect(grow).toMatchObject({ status: 422, code: 'attachment_not_in_repo' });
    expect(await history(sup)).toHaveLength(before);
    // the text is not indexed for search at 1 MB? it is (the limit is inclusive)
    const entry = (await w.as(sameera, (tx) => svc.index.entries(tx, sup, 'pages/big.md')))[0];
    expect(entry?.textPlain?.length).toBe(1_048_576);
  });

  it('binary is judged on the first 8 KB: a NUL there is refused, a NUL later is stored without search text', async () => {
    const svc = w.replica();
    const early = Buffer.concat([Buffer.from('text'), Buffer.from([0]), Buffer.from('more')]);
    const err = await w.as(sameera, (tx) => svc.write(tx, sup, person(sameera), [{ path: 'pages/early.dat', op: 'put', content: early }], 'early nul')).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'attachment_not_in_repo' });
    const late = Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0]), Buffer.from('tail')]);
    await w.as(sameera, (tx) => svc.write(tx, sup, person(sameera), [{ path: 'pages/late.dat', op: 'put', content: late }], 'late nul'));
    const entry = (await w.as(sameera, (tx) => svc.index.entries(tx, sup, 'pages/late.dat')))[0];
    expect(entry).toMatchObject({ size: late.length, textPlain: null });
  });
});

describe('one writer per team across replicas', () => {
  it('20 writes through two services (two queues, one database) are one linear history and a consistent index', async () => {
    const a = w.replica();
    const b = w.replica();
    const before = (await history(sup)).length;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        w.as(sameera, (tx) => (i % 2 ? a : b).write(tx, sup, person(sameera), [{ path: `pages/r/${i}.md`, op: 'put', ...text(`r${i}\n`) }], `R${i}`)),
      ),
    );
    expect(new Set(results.map((r) => r.sha)).size).toBe(20);
    const commits = await history(sup);
    expect(commits).toHaveLength(before + 20);
    for (const c of commits) expect(c.parents.length).toBeLessThanOrEqual(1);
    // every commit's parent is the previous result: linear, no merge, nothing lost
    const byParent = new Map(results.map((r) => [r.parentSha, r.sha]));
    expect(byParent.size).toBe(20);
    const rows = await w.as(sameera, (tx) => a.index.entries(tx, sup, 'pages/r/'));
    expect(rows).toHaveLength(20);
    const repo = await w.as(sameera, (tx) => a.index.repo(tx, sup));
    expect(repo?.headSha).toBe(commits[0]?.sha);
    expect((await w.as(sameera, (tx) => a.index.commits(tx, sup, 500))).length).toBe(commits.length);
  });

  it('a transaction that rolls back after its commit leaves git ahead; the next write catches the index up', async () => {
    const svc = w.replica();
    let orphan = '';
    await w
      .as(sameera, async (tx) => {
        const r = await svc.write(tx, sup, person(sameera), [{ path: 'pages/orphan.md', op: 'put', ...text('written, then rolled back\n') }], 'Orphan');
        orphan = r.sha;
        throw new Error('the request failed after the commit');
      })
      .catch(() => undefined);
    expect(await git.resolve(w.gitDir(sup), 'main')).toBe(orphan);
    expect((await w.as(sameera, (tx) => svc.index.repo(tx, sup)))?.headSha).not.toBe(orphan);

    const next = await w.as(sameera, (tx) => svc.write(tx, sup, person(sameera), [{ path: 'pages/after.md', op: 'put', ...text('after\n') }], 'After'));
    expect(next.parentSha).toBe(orphan);
    const paths = (await w.as(sameera, (tx) => svc.index.entries(tx, sup, 'pages/'))).map((e) => e.path);
    expect(paths).toContain('pages/orphan.md');
    expect(paths).toContain('pages/after.md');
    const commits = await w.as(sameera, (tx) => svc.index.commits(tx, sup, 500));
    const healed = commits.find((c) => c.sha === orphan);
    expect(healed).toMatchObject({ authorId: sameera.actorId, paths: ['pages/orphan.md'], message: 'Orphan' });
    expect((await w.as(sameera, (tx) => svc.index.repo(tx, sup)))?.headSha).toBe(next.sha);
  });

  it('a commit made outside the writer is indexed with its author read back from the identity', async () => {
    const svc = w.replica();
    const dir = w.gitDir(sup);
    const old = (await git.resolve(dir, 'main'))!;
    const made = await git.commit(dir, {
      expectedOld: old,
      changes: [{ path: 'pages/external.md', op: 'put', content: Buffer.from('pushed in\n') }],
      message: 'External',
      author: { name: 'Rafi', email: `${rafi.actorId}@actors.manythreads.invalid` },
      coAuthors: [{ name: 'Tariq', email: `${tariq.actorId}@actors.manythreads.invalid` }, { name: 'Stranger', email: 'x@example.com' }],
    });
    if (made.noop) throw new Error('x');
    await w.as(sameera, (tx) => svc.write(tx, sup, person(sameera), [{ path: 'pages/after-external.md', op: 'put', ...text('x\n') }], 'After external'));
    const c = (await w.as(sameera, (tx) => svc.index.commits(tx, sup, 500))).find((r) => r.sha === made.sha);
    expect(c).toMatchObject({ authorId: rafi.actorId, coAuthors: [tariq.actorId], parentSha: old });
  });
});

describe('creating the repository', () => {
  it('two replicas asking at once for a team with no repo make one first commit', async () => {
    const mkt = TEAM_IDS.Marketing;
    const a = w.replica();
    const b = w.replica();
    await Promise.all([w.as(tariq, (tx) => a.ensure(tx, mkt)), w.as(tariq, (tx) => b.ensure(tx, mkt)), w.as(tariq, (tx) => a.ensure(tx, mkt))]);
    const commits = await history(mkt);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.author.name).toBe('manythreads');
    expect((await w.as(tariq, (tx) => a.index.commits(tx, mkt, 10))).map((c) => [c.sha, c.authorId])).toEqual([[commits[0]?.sha, null]]);
  });

  it('a lost repository directory is recreated from the team and the index follows git', async () => {
    const eng = TEAM_IDS.Engineering;
    const a = w.replica();
    await w.as(rafi, (tx) => a.ensure(tx, eng));
    const { rmSync } = await import('node:fs');
    rmSync(w.gitDir(eng), { recursive: true, force: true });
    await w.as(rafi, (tx) => a.ensure(tx, eng));
    const commits = await history(eng);
    expect(commits).toHaveLength(1);
    const repo = await w.as(rafi, (tx) => a.index.repo(tx, eng));
    expect(repo?.headSha).toBe(commits[0]?.sha);
    expect((await w.as(rafi, (tx) => a.index.entries(tx, eng))).length).toBe(8);
  });
});

describe('append, delete and restore', () => {
  it('restore puts an old version back as a new commit, history keeps every commit, a deleted file comes back', async () => {
    const svc = w.replica();
    const act = person(sameera);
    const v1 = await w.as(sameera, (tx) => svc.write(tx, sup, act, [{ path: 'pages/restore.md', op: 'put', ...text('one\n') }], 'v1'));
    await w.as(sameera, (tx) => svc.write(tx, sup, act, [{ path: 'pages/restore.md', op: 'put', ...text('two\n') }], 'v2'));
    const before = (await history(sup)).length;
    const back = await w.as(sameera, (tx) => svc.restore(tx, sup, act, 'pages/restore.md', v1.sha));
    expect(back.noop).toBe(false);
    expect((await history(sup))).toHaveLength(before + 1);
    expect((await history(sup))[0]?.subject).toBe(`Restore pages/restore.md to ${v1.sha.slice(0, 7)}`);
    expect((await git.blob(w.gitDir(sup), 'pages/restore.md', 'main', 100)).content.toString()).toBe('one\n');
    // the file was deleted, then restored
    await w.as(sameera, (tx) => svc.write(tx, sup, act, [{ path: 'pages/restore.md', op: 'delete' }], 'rm'));
    expect((await w.as(sameera, (tx) => svc.index.entries(tx, sup, 'pages/restore.md')))).toHaveLength(0);
    await w.as(sameera, (tx) => svc.restore(tx, sup, act, 'pages/restore.md', v1.sha));
    expect((await w.as(sameera, (tx) => svc.index.entries(tx, sup, 'pages/restore.md')))[0]?.textPlain).toBe('one\n');
    // restoring what did not exist then deletes it
    const first = (await history(sup)).at(-1)!.sha;
    await w.as(sameera, (tx) => svc.restore(tx, sup, act, 'pages/restore.md', first));
    expect((await git.tree(w.gitDir(sup), 'pages', 'main')).entries.some((e) => e.name === 'restore.md')).toBe(false);
    // restore obeys the writer rules: a person who may not change bots/ may not restore it
    const err = await w.as(sameera, (tx) => svc.restore(tx, sup, act, 'bots/.gitkeep', first)).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403 });
  });

  it('log, diff and show read through the service', async () => {
    const svc = w.replica();
    const log = await w.as(sameera, (tx) => svc.log(tx, sup, { path: 'pages/restore.md', limit: 3 }));
    expect(log.commits.length).toBeGreaterThan(0);
    const [newest, older] = log.commits;
    const diff = await w.as(sameera, (tx) => svc.diff(tx, sup, older!.sha, newest!.sha, 'pages/restore.md'));
    expect(diff.files.map((f) => f.path)).toEqual(['pages/restore.md']);
    const shown = await w.as(sameera, (tx) => svc.show(tx, sup, newest!.sha));
    expect(shown.sha).toBe(newest!.sha);
    // a person outside the team reads nothing
    const outsider = await w.as(personas.priya, (tx) => svc.log(tx, sup, { limit: 3 })).catch((e: unknown) => e);
    expect(outsider).toMatchObject({ status: 403 });
    expect(randomUUID()).toBeTruthy();
  });
});
