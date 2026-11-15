import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// P26-09: the team's repository of record in an agent pod. repo-sync.sh makes one bare repository per project at /work/<team>/repos/<project>.git; the bots reach it only through
// `mt-git record-push <branch>` and `mt-git record-fetch`, and its `update` hook refuses main, a delete and a forced push. Real git, a local bare repository as the "public" origin.

const IMAGE = fileURLToPath(new URL('../../../../deploy/images/agent-pod/', import.meta.url));
const SYNC = join(IMAGE, 'repo-sync.sh');
const MT_GIT = join(IMAGE, 'mt-git.mjs');

let root: string;
let origin: string;
let coder: string; // /work/t/coder/proj
let tester: string; // /work/t/tester/proj
let record: string; // /work/t/repos/proj.git

const BASE = (): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...BASE(), ...IDENT } });
const ok = (r: { status: number | null; stderr: string }) => expect(r.status, r.stderr).toBe(0);
const mt = (cwd: string, args: string[]) => {
  const r = spawnSync('node', [MT_GIT, ...args], { cwd, encoding: 'utf8', env: { ...BASE(), ...IDENT } });
  return { code: r.status, all: r.stdout + r.stderr };
};
const sync = (extra: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync('sh', [SYNC], {
    encoding: 'utf8',
    env: {
      ...BASE(),
      REPO_SYNC_ONCE: '1',
      REPO_SYNC_ALLOW_FILE: '1',
      REPO_SYNC_FILE_ADDRESSES: '1',
      REPO_SYNC_SCRATCH: join(root, 'scratch'),
      REPO_SYNC_LIST: join(root, 'list.txt'),
      REPO_SYNC_FALLBACK: join(root, 'none'),
      REPO_SYNC_WORK: join(root, 'work'),
      REPO_SYNC_FETCH_EVERY: '1',
      REPO_SYNC_RETRY_AFTER: '0',
      ...extra,
    },
  });
  return { code: r.status, out: r.stdout + r.stderr };
};
const commitTo = (bare: string, text: string): string => {
  const w = mkdtempSync(join(root, 'w-'));
  ok(git(w, ['clone', '-q', bare, '.']));
  writeFileSync(join(w, 'a.txt'), text);
  ok(git(w, ['add', 'a.txt']));
  ok(git(w, ['commit', '-q', '-m', text]));
  ok(git(w, ['push', '-q', 'origin', 'HEAD:refs/heads/main']));
  return git(w, ['rev-parse', 'HEAD']).stdout.trim();
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'record-'));
  origin = join(root, 'origin.git');
  coder = join(root, 'work', 't', 'coder', 'proj');
  tester = join(root, 'work', 't', 'tester', 'proj');
  record = join(root, 'work', 't', 'repos', 'proj.git');
  ok(git(root, ['init', '-q', '--bare', '-b', 'main', origin]));
  commitTo(origin, 'one\n');
  writeFileSync(join(root, 'list.txt'), `t coder proj - file://${origin}\nt tester proj - file://${origin}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A card branch with one commit, made in the coder's clone. */
const cardInCoder = (name: string, text = 'work\n'): string => {
  ok(git(coder, ['switch', '-q', '-c', name]));
  writeFileSync(join(coder, 'b.txt'), text);
  ok(git(coder, ['add', 'b.txt']));
  ok(git(coder, ['commit', '-q', '-m', text]));
  return git(coder, ['rev-parse', 'HEAD']).stdout.trim();
};

describe('the repository of record', () => {
  it('is made once per team and project, bare, with the update hook, and the bots keep their own clones', () => {
    const r = sync();
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(record, 'objects'))).toBe(true);
    expect(git(record, ['rev-parse', '--is-bare-repository']).stdout.trim()).toBe('true');
    expect(readFileSync(join(record, 'hooks', 'update'), 'utf8')).toMatch(/forced push/);
    expect(lstatSync(join(record, 'hooks', 'update')).mode & 0o111).not.toBe(0);
    expect(existsSync(join(coder, '.git'))).toBe(true);
    expect(existsSync(join(tester, '.git'))).toBe(true);
    // a clone's origin is still the public address (the fetch rule of repo-sync.sh depends on it)
    expect(git(coder, ['config', '--get', 'remote.origin.url']).stdout.trim()).toBe(`file://${origin}`);
    expect(existsSync(join(root, 'work', 't', 'repos', '.record.proj'))).toBe(false); // the hidden name used while cloning is gone
  });

  it('follows the default branch of the origin on the next round and leaves a pushed card branch alone', () => {
    sync();
    ok(git(coder, ['config', 'user.name', 't']));
    cardInCoder('card-aaaa1111');
    expect(mt(coder, ['record-push', 'card-aaaa1111']).code).toBe(0);
    const c2 = commitTo(origin, 'two\n');
    const r = sync();
    expect(r.code, r.out).toBe(0);
    expect(git(record, ['rev-parse', 'refs/heads/main']).stdout.trim()).toBe(c2);
    expect(git(record, ['rev-parse', '--verify', '-q', 'refs/heads/card-aaaa1111']).status).toBe(0);
  });

  it('is not made through a link, and a link in its place is not followed', () => {
    mkdirSync(join(root, 'work', 't'), { recursive: true });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'work', 't', 'repos'));
    const r = sync();
    expect(r.out).toMatch(/no repository of record/);
    expect(existsSync(join(elsewhere, 'proj.git'))).toBe(false);
  });
});

describe('mt-git record-push and record-fetch', () => {
  beforeEach(() => {
    ok(git(root, ['--version']));
    sync();
    ok(git(coder, ['config', 'user.name', 't']));
  });

  it('carry a card branch from the coder to the tester, who then starts a branch of its own from it', () => {
    const sha = cardInCoder('card-bbbb2222');
    const push = mt(coder, ['record-push', 'card-bbbb2222']);
    expect(push.code, push.all).toBe(0);
    expect(git(record, ['rev-parse', 'refs/heads/card-bbbb2222']).stdout.trim()).toBe(sha);
    const fetch = mt(tester, ['record-fetch']);
    expect(fetch.code, fetch.all).toBe(0);
    expect(git(tester, ['rev-parse', 'refs/record/card-bbbb2222']).stdout.trim()).toBe(sha);
    const co = mt(tester, ['checkout', '-b', 'card-bbbb2222-test', 'refs/record/card-bbbb2222']);
    expect(co.code, co.all).toBe(0);
    expect(readFileSync(join(tester, 'b.txt'), 'utf8')).toBe('work\n');
  });

  it('refuse main, other branch names with odd characters, a missing name, and extra arguments', () => {
    cardInCoder('card-cccc3333');
    for (const bad of ['main', 'master', '--force', 'a..b', 'x.lock', 'refs/heads/x', '+card', '']) expect(mt(coder, ['record-push', bad]).code, bad).toBe(2);
    expect(mt(coder, ['record-push']).code).toBe(2);
    expect(mt(coder, ['record-push', 'a', 'b']).code).toBe(2);
    expect(mt(coder, ['record-fetch', 'origin']).code).toBe(2);
  });

  it('the update hook refuses a forced push and a delete of a branch the record holds', () => {
    cardInCoder('card-dddd4444', 'first\n');
    expect(mt(coder, ['record-push', 'card-dddd4444']).code).toBe(0);
    // rewrite history on the branch, then push again: a forced update the hook must refuse
    ok(git(coder, ['commit', '-q', '--amend', '-m', 'rewritten']));
    const again = mt(coder, ['record-push', 'card-dddd4444']);
    expect(again.code).not.toBe(0);
    expect(again.all).toMatch(/forced push|non-fast-forward|rejected/);
    // deleting needs a command mt-git does not run; the hook still refuses it when git is used directly on the record
    const del = git(coder, ['push', record, ':refs/heads/card-dddd4444']);
    expect(del.status).not.toBe(0);
    expect(git(record, ['rev-parse', '--verify', '-q', 'refs/heads/card-dddd4444']).status).toBe(0);
  });

  it('the update hook refuses a push to main made with plain git', () => {
    cardInCoder('card-eeee5555');
    const r = git(coder, ['push', record, 'HEAD:refs/heads/main']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/main branch is not pushed/);
  });

  it('do not follow a link in place of the record, and say plainly when there is none yet', () => {
    cardInCoder('card-ffff6666');
    rmSync(record, { recursive: true });
    expect(mt(coder, ['record-push', 'card-ffff6666']).all).toMatch(/no repository of record/);
    const elsewhere = join(root, 'elsewhere.git');
    ok(git(root, ['init', '-q', '--bare', elsewhere]));
    symlinkSync(elsewhere, record);
    const r = mt(coder, ['record-push', 'card-ffff6666']);
    expect(r.code).toBe(2);
    expect(r.all).toMatch(/not a plain folder/);
    expect(git(elsewhere, ['rev-parse', '--verify', '-q', 'refs/heads/card-ffff6666']).status).not.toBe(0);
  });
});
