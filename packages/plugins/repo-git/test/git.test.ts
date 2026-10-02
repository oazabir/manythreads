import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRepoPath } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertGitPath, neutraliseTrailerLines, parseCoAuthors, createGitLayer, createGitRunner, GitBlobTooLargeError, GitError, GitNotFoundError, GitPathError, type GitLayer } from '../src/git/index.ts';

// Real git in temporary directories: the git layer's contract (PLAN P4-03). No database.

const root = mkdtempSync(join(tmpdir(), 'manythreads-git-test-'));
const git: GitLayer = createGitLayer();
let n = 0;
const fresh = async (): Promise<string> => {
  const dir = join(root, `r${(n += 1)}.git`);
  await git.initBare(dir);
  return dir;
};
const ada = { name: 'Ada Lovelace', email: 'ada@actors.manythreads.invalid' };
const bo = { name: 'Bo Bot', email: 'bo@actors.manythreads.invalid' };
const text = (s: string): Uint8Array => Buffer.from(s);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('trailers in messages', () => {
  const t = (name: string): string => `Co-authored-by: ${name} <a@actors.manythreads.invalid>`;
  it('reads co-authors only from a final paragraph made of trailers, from column 0', () => {
    expect(parseCoAuthors(`Subject\n\nbody\n\n${t('Bo')}\n${t('Cy')}\n`).map((c) => c.name)).toEqual(['Bo', 'Cy']);
    expect(parseCoAuthors(`Subject\n\n${t('Bo')}\n\nmore text after`)).toEqual([]); // not the final paragraph
    expect(parseCoAuthors(`Subject\n${t('Bo')}`)).toEqual([]); // the subject paragraph is not a trailer block
    expect(parseCoAuthors(`Subject\n\n  ${t('Bo')}`)).toEqual([]); // indented
    expect(parseCoAuthors(`Subject\n\nsome words\n${t('Bo')}`)).toEqual([]); // a block with prose in it
    expect(parseCoAuthors('')).toEqual([]);
  });
  it('neutralises attribution lines of any case, indentation and line ending, and nothing else', () => {
    const out = neutraliseTrailerLines(`Fix\n\n${t('A')}\n  CO-AUTHORED-BY: B <b@x.test>\r\nSigned-off-by: C <c@x.test>\rFixes: 12\nco-authored-by:D`);
    expect(out).toBe('Fix\n\n> Co-authored-by: A <a@actors.manythreads.invalid>\n> CO-AUTHORED-BY: B <b@x.test>\n> Signed-off-by: C <c@x.test>\nFixes: 12\n> co-authored-by:D');
    expect(parseCoAuthors(out)).toEqual([]);
  });
  it('a hostile message is linear', () => {
    const hostile = `x\n\n${'Co-authored-by: '.repeat(20000)}<${'a'.repeat(40000)}`;
    const t0 = performance.now();
    neutraliseTrailerLines(hostile);
    parseCoAuthors(hostile);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it('commit() neutralises user trailers and appends only its own', async () => {
    const dir = await fresh();
    const r = await git.commit(dir, { expectedOld: null, changes: [{ path: 'a.md', op: 'put', content: text('x') }], message: `Msg\n\n${t('Mallory')}`, author: ada, coAuthors: [bo] });
    if (r.noop) throw new Error('x');
    const info = await git.commitInfo(dir, r.sha);
    expect(info.coAuthors.map((c) => c.email)).toEqual(['bo@actors.manythreads.invalid']);
    expect(info.message).toContain('> Co-authored-by: Mallory');
  });
});

describe('init', () => {
  it('creates a bare repository without hooks and is idempotent', async () => {
    const dir = await fresh();
    expect(existsSync(join(dir, 'HEAD'))).toBe(true);
    expect(existsSync(join(dir, 'hooks')) ? readdirSync(join(dir, 'hooks')) : []).toEqual([]);
    await git.initBare(dir);
    expect(await git.resolve(dir, 'main')).toBeNull();
  });
});

describe('commit, tree, blob', () => {
  it('commits through a temporary index, lists folders first, reads blobs, leaves no index file behind', async () => {
    const dir = await fresh();
    const r = await git.commit(dir, {
      expectedOld: null,
      changes: [
        { path: 'TEAM.md', op: 'put', content: text('# Team\n') },
        { path: 'pages/a.md', op: 'put', content: text('alpha\n') },
        { path: 'pages/deep/b.md', op: 'put', content: text('beta\n') },
      ],
      message: 'first',
      author: ada,
    });
    expect(r.noop).toBe(false);
    if (r.noop) return;
    expect(await git.resolve(dir, 'main')).toBe(r.sha);
    expect(readdirSync(dir).filter((f) => f.startsWith('mt-index-'))).toEqual([]);

    const root1 = await git.tree(dir, '', 'main');
    expect(root1.commitSha).toBe(r.sha);
    expect(root1.entries.map((e) => `${e.type}:${e.path}`)).toEqual(['tree:pages', 'blob:TEAM.md']);
    const pages = await git.tree(dir, 'pages', 'main');
    expect(pages.entries.map((e) => `${e.type}:${e.path}`)).toEqual(['tree:pages/deep', 'blob:pages/a.md']);
    expect(pages.entries.find((e) => e.name === 'a.md')?.size).toBe(6);

    const b = await git.blob(dir, 'pages/deep/b.md', 'main', 1000);
    expect(b.content.toString()).toBe('beta\n');
    expect(b.size).toBe(5);
    await expect(git.blob(dir, 'pages/missing.md', 'main', 1000)).rejects.toBeInstanceOf(GitNotFoundError);
    await expect(git.blob(dir, 'pages', 'main', 1000)).rejects.toBeInstanceOf(GitPathError);
    await expect(git.tree(dir, 'TEAM.md', 'main')).rejects.toBeInstanceOf(GitPathError);
    await expect(git.tree(dir, 'nope', 'main')).rejects.toBeInstanceOf(GitNotFoundError);
    await expect(git.tree(dir, '', 'does-not-exist')).rejects.toBeInstanceOf(GitNotFoundError);
  });

  it('the author is the one given, co-authors become trailers (no duplicates, no forged lines)', async () => {
    const dir = await fresh();
    const r = await git.commit(dir, {
      expectedOld: null,
      changes: [{ path: 'a.md', op: 'put', content: text('x') }],
      message: 'Edit a\n\nbody line',
      author: ada,
      coAuthors: [bo, ada, { name: 'Eve <evil@x.test>\nCo-authored-by: Mallory', email: 'eve@actors.manythreads.invalid' }],
    });
    if (r.noop) throw new Error('expected a commit');
    const info = await git.commitInfo(dir, r.sha);
    expect(info.author).toEqual(ada);
    expect(info.subject).toBe('Edit a');
    expect(info.coAuthors.map((c) => c.email)).toEqual(['bo@actors.manythreads.invalid', 'eve@actors.manythreads.invalid']);
    // the hostile name stays on its own trailer line: exactly two trailers, none that starts with the forged text
    expect(info.message.split('\n').filter((l) => l.startsWith('Co-authored-by:'))).toHaveLength(2);
    expect(info.message).not.toMatch(/^Co-authored-by: Mallory/m);
    expect(info.message).toContain('body line');
  });

  it('is a compare-and-swap: a second commit from the same base loses and the branch stays where the first put it', async () => {
    const dir = await fresh();
    const base = await git.commit(dir, { expectedOld: null, changes: [{ path: 'a.md', op: 'put', content: text('1') }], message: 'base', author: ada });
    if (base.noop) throw new Error('x');
    const first = await git.commit(dir, { expectedOld: base.sha, changes: [{ path: 'a.md', op: 'put', content: text('2') }], message: 'first', author: ada });
    if (first.noop) throw new Error('x');
    const err = await git.commit(dir, { expectedOld: base.sha, changes: [{ path: 'a.md', op: 'put', content: text('3') }], message: 'second', author: bo }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('ref_conflict');
    expect(await git.resolve(dir, 'main')).toBe(first.sha);
    // creating a branch that exists is a conflict too
    const again = await git.commit(dir, { expectedOld: null, changes: [{ path: 'b.md', op: 'put', content: text('1') }], message: 'again', author: bo }).catch((e: unknown) => e);
    expect((again as GitError).code).toBe('ref_conflict');
  });

  it('a change set that leaves the tree as it was is a no-op, a delete removes the file and an empty folder with it', async () => {
    const dir = await fresh();
    const base = await git.commit(dir, { expectedOld: null, changes: [{ path: 'd/x.md', op: 'put', content: text('1') }, { path: 'k.md', op: 'put', content: text('k') }], message: 'base', author: ada });
    if (base.noop) throw new Error('x');
    const same = await git.commit(dir, { expectedOld: base.sha, changes: [{ path: 'd/x.md', op: 'put', content: text('1') }], message: 'same', author: ada });
    expect(same).toEqual({ noop: true, sha: base.sha });
    const gone = await git.commit(dir, { expectedOld: base.sha, changes: [{ path: 'd/x.md', op: 'delete' }, { path: 'never/was.md', op: 'delete' }], message: 'rm', author: ada });
    if (gone.noop) throw new Error('x');
    expect((await git.tree(dir, '', 'main')).entries.map((e) => e.path)).toEqual(['k.md']);
  });

  it('file names are data, not shell: metacharacters, spaces and unicode round-trip', async () => {
    const dir = await fresh();
    const names = ['a; touch pwned.md', '$(touch pwned2).md', 'x y/z`z`.md', 'naïve/日本語.md', '-rf.md', '--help'];
    await git.commit(dir, { expectedOld: null, changes: names.map((p) => ({ path: p, op: 'put' as const, content: text(p) })), message: 'names', author: ada });
    for (const p of names) expect((await git.blob(dir, p, 'main', 100)).content.toString()).toBe(p);
    expect(existsSync(join(dir, 'pwned.md')) || existsSync(join(dir, 'pwned2'))).toBe(false);
  });

  it('refuses a blob over the cap before reading it', async () => {
    const dir = await fresh();
    await git.commit(dir, { expectedOld: null, changes: [{ path: 'big.md', op: 'put', content: Buffer.alloc(5000, 97) }], message: 'big', author: ada });
    const err = await git.blob(dir, 'big.md', 'main', 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitBlobTooLargeError);
    expect((err as GitBlobTooLargeError).size).toBe(5000);
    expect((await git.blob(dir, 'big.md', 'main', 5000)).content.length).toBe(5000);
  });
});

describe('log, diff, show, restore', () => {
  it('pages the log by cursor, filters by path, diffs two commits, shows one, restores as a change', async () => {
    const dir = await fresh();
    let old: string | null = null;
    const shas: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const r = await git.commit(dir, {
        expectedOld: old,
        changes: [
          { path: i % 2 ? 'odd.md' : 'even.md', op: 'put', content: text(`v${i}\n`) },
          { path: 'all.md', op: 'put', content: text(`all ${i}\n`) },
        ],
        message: `c${i}`,
        author: i % 2 ? ada : bo,
      });
      if (r.noop) throw new Error('x');
      old = r.sha;
      shas.push(r.sha);
    }
    const p1 = await git.log(dir, { limit: 2 });
    expect(p1.commits.map((c) => c.subject)).toEqual(['c5', 'c4']);
    expect(p1.nextCursor).toBe(shas[3]);
    const p2 = await git.log(dir, { limit: 2, cursor: p1.nextCursor });
    expect(p2.commits.map((c) => c.subject)).toEqual(['c3', 'c2']);
    const p3 = await git.log(dir, { limit: 2, cursor: p2.nextCursor });
    expect(p3.commits.map((c) => c.subject)).toEqual(['c1']);
    expect(p3.nextCursor).toBeNull();
    expect((await git.log(dir, { limit: 10, path: 'odd.md' })).commits.map((c) => c.subject)).toEqual(['c5', 'c3', 'c1']);
    expect((await git.log(dir, { limit: 10 })).commits[0]?.author).toEqual(ada);

    const d = await git.diff(dir, shas[0]!, shas[4]!, 'all.md');
    expect(d.files).toEqual([{ status: 'M', path: 'all.md' }]);
    expect(d.patch).toContain('-all 1');
    expect(d.patch).toContain('+all 5');
    expect(d.truncated).toBe(false);

    const s = await git.show(dir, shas[1]!);
    expect(s.subject).toBe('c2');
    expect(s.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual(['A:even.md', 'M:all.md']);
    const first = await git.show(dir, shas[0]!);
    expect(first.files.map((f) => f.status)).toEqual(['A', 'A']);
    await expect(git.show(dir, '0'.repeat(40))).rejects.toBeInstanceOf(GitNotFoundError);

    const back = await git.restoreChange(dir, 'all.md', shas[0]!, 1000);
    expect(back).toMatchObject({ op: 'put', path: 'all.md' });
    expect(back.op === 'put' && Buffer.from(back.content).toString()).toBe('all 1\n');
    expect(await git.restoreChange(dir, 'even.md', shas[0]!, 1000)).toEqual({ path: 'even.md', op: 'delete' });
    const c = await git.commit(dir, { expectedOld: shas[4]!, changes: [back], message: 'restore', author: ada });
    if (c.noop) throw new Error('x');
    expect((await git.log(dir, { limit: 50 })).commits.length).toBe(6); // history kept, restore added one
    expect((await git.blob(dir, 'all.md', 'main', 100)).content.toString()).toBe('all 1\n');
  });
});

describe('paths and refs are validated before they reach git', () => {
  it.each(['', '/etc/passwd', 'a/../b', '../x', 'a//b', './a', 'a/./b', '.git/config', 'x/.GIT/y', 'a\\b', 'a\0b', 'dir/'])('assertGitPath rejects %j', (p) => {
    expect(() => assertGitPath(p)).toThrow(GitPathError);
  });
  it.each(['..', '--output=x', '-x', 'a b', 'a..b', 'x.lock', '', '$(x)', 'a;b'])('refs: %j is refused', async (ref) => {
    const dir = await fresh();
    await expect(git.tree(dir, '', ref)).rejects.toBeInstanceOf(GitPathError);
  });
  it('parseRepoPath: NFC, strictness and the .git rule', () => {
    expect(parseRepoPath('café/menu.md')).toEqual({ ok: true, path: 'café/menu.md' });
    for (const bad of ['', '/a', 'a/', 'a//b', 'a/../b', '..', '.', '.git', 'a/.GIT/x', 'a/.git ', '.gitmodules', 'a\\b', 'a\u0000b', 'a\nb', 'x.', 'x /y', `${'a'.repeat(300)}`, `${'a/'.repeat(600)}b`]) {
      expect(parseRepoPath(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseRepoPath('.gitkeep').ok).toBe(true);
    expect(parseRepoPath('pages/.gitignore').ok).toBe(true);
  });
});

describe('the process boundary', () => {
  it('ignores the caller environment and repository hooks and config', async () => {
    const dir = await fresh();
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    const marker = join(root, 'hook-ran');
    for (const hook of ['reference-transaction', 'pre-commit', 'post-update']) {
      writeFileSync(join(dir, 'hooks', hook), `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(join(dir, 'hooks', hook), 0o755);
    }
    const saved = { ...process.env };
    Object.assign(process.env, {
      GIT_DIR: '/nonexistent',
      GIT_AUTHOR_NAME: 'Intruder',
      GIT_COMMITTER_EMAIL: 'intruder@x.test',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: join(dir, 'hooks'),
      GIT_EXEC_PATH: '/nonexistent',
      GIT_INDEX_FILE: '/nonexistent/index',
    });
    try {
      const r = await git.commit(dir, { expectedOld: null, changes: [{ path: 'a.md', op: 'put', content: text('x') }], message: 'clean room', author: ada });
      if (r.noop) throw new Error('x');
      const info = await git.commitInfo(dir, r.sha);
      expect(info.author).toEqual(ada);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses environment variables that are not on the allow list', async () => {
    const runner = createGitRunner();
    await expect(runner.run(['version'], { env: { GIT_DIR: '/x' } })).rejects.toThrow(/not allowed/);
  });

  it('never allows a transport: clone from a local path is refused', async () => {
    const src = await fresh();
    const dest = join(root, 'cloned');
    await expect(createGitRunner().run(['clone', src, dest])).rejects.toBeInstanceOf(GitError);
    expect(existsSync(dest)).toBe(false);
  });

  const script = (name: string, body: string): string => {
    const file = join(root, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it('kills a git process that runs past its timeout', async () => {
    const slow = createGitRunner({ bin: script('slow.sh', 'sleep 30') });
    const started = Date.now();
    const err = await slow.run(['log'], { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(slow.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it('caps output: an error by default, a truncated prefix on request', async () => {
    const loud = createGitRunner({ bin: script('loud.sh', 'yes abcdefghij | head -c 1000000') });
    const err = await loud.run(['log'], { maxOutputBytes: 1000 }).catch((e: unknown) => e);
    expect((err as GitError).code).toBe('output_too_large');
    const cut = await loud.run(['log'], { maxOutputBytes: 1000, onOverflow: 'truncate' });
    expect(cut.truncated).toBe(true);
    expect(cut.stdout.length).toBe(1000);
  });

  it('runs at most poolSize processes at once and queues the rest', async () => {
    const pooled = createGitRunner({ bin: script('nap.sh', 'sleep 0.3'), poolSize: 2 });
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, pooled.stats().running)), 10);
    const started = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => pooled.run(['log'])));
    clearInterval(watch);
    expect(peak).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(850); // three waves of 300 ms
  });

  it('refuses with `busy` once maxQueue calls are waiting, and recovers when they finish', async () => {
    const r = createGitRunner({ bin: script('nap2.sh', 'sleep 0.3'), poolSize: 1, maxQueue: 2 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => r.run(['log'])));
    const refused = results.filter((x) => x.status === 'rejected' && (x.reason as GitError).code === 'busy');
    expect(refused).toHaveLength(2); // 1 running + 2 waiting; the other two are turned away at once
    expect(r.stats()).toEqual({ running: 0, waiting: 0 });
    await expect(r.run(['log'])).resolves.toBeTruthy();
  });

  it('one repository cannot take every slot: another repository starts while the first has calls waiting', async () => {
    const r = createGitRunner({ bin: script('nap3.sh', 'sleep 0.4'), poolSize: 4, perRepoMax: 2, maxQueue: 50 });
    const t0 = Date.now();
    let otherDone = 0;
    const flood = Array.from({ length: 6 }, () => r.run(['log'], { gitDir: join(root, 'a.git') }));
    const other = r.run(['log'], { gitDir: join(root, 'b.git') }).then(() => (otherDone = Date.now() - t0));
    expect(r.stats().running).toBe(3); // two of A, one of B at once
    await Promise.all([...flood, other]);
    expect(otherDone).toBeLessThan(700); // not queued behind A's six calls (three waves, 1.2 s)
  });

  it('literal pathspecs: a pattern in a path matches nothing but a file of that name', async () => {
    const dir = await fresh();
    const r = await git.commit(dir, { expectedOld: null, changes: [{ path: 'pages/a.md', op: 'put', content: text('a') }, { path: 'pages/b.md', op: 'put', content: text('b') }], message: 'two', author: ada });
    if (r.noop) throw new Error('x');
    expect((await git.log(dir, { limit: 10, path: 'pages/a.md' })).commits).toHaveLength(1);
    for (const pattern of ['pages/*', ':(glob)pages/**', ':(top)pages', 'pages/?.md']) {
      expect((await git.log(dir, { limit: 10, path: pattern })).commits, pattern).toHaveLength(0);
    }
  });

  it('reports a missing git binary as unavailable', async () => {
    const err = await createGitRunner({ bin: join(root, 'no-such-git') }).run(['version']).catch((e: unknown) => e);
    expect((err as GitError).code).toBe('unavailable');
  });
});

beforeAll(() => mkdirSync(root, { recursive: true }));
