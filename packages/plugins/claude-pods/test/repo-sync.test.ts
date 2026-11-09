import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PodRunnerInfo } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configFrom } from '../src/config.ts';
import { buildDeployment, namesFor, REPO_SYNC_SCRATCH } from '../src/render.ts';

// P19-09 security review: the repo-sync container of a Claude or Codex pod fetches into a clone the BOT can write (same /work, same /tmp, same user). `git -C <clone> fetch`
// reads that clone's own .git/config and .git/hooks, so a bot that had written `remote.origin.uploadpack`, `core.sshCommand`, an `include`, a `url.*.insteadOf`, a hooks folder
// or a hook file had a command run in the container that has the network (or a fetch from another address). These tests run deploy/images/claude-pod/repo-sync.sh with real git
// and a local bare repository as the origin (REPO_SYNC_ALLOW_FILE lets the test use a file:// address; the pod sets none of the REPO_SYNC_* hooks). Each attack is first run as
// plain `git fetch` (the control: it really starts the program), then through the script (nothing runs, the right address is fetched).

const SCRIPT = fileURLToPath(new URL('../../../../deploy/images/claude-pod/repo-sync.sh', import.meta.url));

let root: string;
let origin: string; // the bare repository the project list names
let evil: string; // another bare repository, with a different history
let clone: string; // /work/t/b/proj
let marker: string; // a file a hostile program would create
let originUrl: string;

const BASE_ENV = (): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...BASE_ENV(), ...IDENT, ...env } });
const ok = (r: { status: number | null; stderr: string }) => expect(r.status, r.stderr).toBe(0);

/** A commit in `bare`, made through a throw-away working copy. Returns the commit id. */
const commitTo = (bare: string, file: string, text: string): string => {
  const w = mkdtempSync(join(root, 'w-'));
  ok(git(w, ['clone', '-q', bare, '.']));
  writeFileSync(join(w, file), text);
  ok(git(w, ['add', file]));
  ok(git(w, ['commit', '-q', '-m', text]));
  ok(git(w, ['push', '-q', 'origin', 'HEAD:refs/heads/main']));
  return git(w, ['rev-parse', 'HEAD']).stdout.trim();
};

const runSync = (env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync('sh', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...BASE_ENV(),
      REPO_SYNC_ONCE: '1',
      REPO_SYNC_ALLOW_FILE: '1',
      REPO_SYNC_FILE_ADDRESSES: '1',
      REPO_SYNC_SCRATCH: join(root, 'scratch'),
      REPO_SYNC_LIST: join(root, 'list.txt'),
      REPO_SYNC_FALLBACK: join(root, 'no-such-list'),
      REPO_SYNC_WORK: join(root, 'work'),
      REPO_SYNC_FETCH_EVERY: '1',
      REPO_SYNC_RETRY_AFTER: '0',
      ...env,
    },
  });
  return { code: r.status, out: r.stdout + r.stderr };
};
const remoteRef = (dir = clone) => git(dir, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main']).stdout.trim();
const hasObject = (dir: string, sha: string) => git(dir, ['cat-file', '-e', sha]).status === 0;
const hook = (path: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  chmodSync(path, 0o755);
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-sync-'));
  marker = join(root, 'RAN');
  origin = join(root, 'origin.git');
  evil = join(root, 'evil.git');
  clone = join(root, 'work', 't', 'b', 'proj');
  originUrl = `file://${origin}`;
  for (const bare of [origin, evil]) ok(git(root, ['init', '-q', '--bare', '-b', 'main', bare]));
  commitTo(origin, 'a.txt', 'one\n');
  commitTo(evil, 'evil.txt', 'EVIL\n');
  writeFileSync(join(root, 'list.txt'), `t b proj - ${originUrl}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the sync itself', () => {
  it('clones a project, then fetches what the origin gained, and the clone holds no hook and no extra setting', () => {
    const first = runSync();
    expect(first.code, first.out).toBe(0);
    const c1 = remoteRef();
    expect(c1).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(clone, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(clone, '.git', 'hooks'))).toBe(false); // empty templates: no sample hook is copied in
    expect(readFileSync(join(clone, '.git', 'config'), 'utf8')).not.toMatch(/hooksPath|fsmonitor|sshCommand|helper/);
    expect(readdirSync(join(root, 'work', 't', 'b')).sort()).toEqual(['proj']); // the hidden name used while cloning is gone
    const c2 = commitTo(origin, 'a.txt', 'two\n');
    const second = runSync();
    expect(second.code, second.out).toBe(0);
    expect(remoteRef()).toBe(c2);
    expect(hasObject(clone, c2)).toBe(true);
    expect(git(clone, ['fsck', '--no-dangling']).status).toBe(0);
  });

  it('clones a named branch, and skips a list line with a bad branch, a non-public address or a name that climbs out of its folder', () => {
    git(origin, ['branch', 'dev', 'main']);
    writeFileSync(
      join(root, 'list.txt'),
      [
        `t b proj - ${originUrl}`,
        `t b onbranch dev ${originUrl}`,
        `t b bad1 --upload-pack=x ${originUrl}`,
        `t b bad2 - https://user:tok@example.invalid/x/y.git`,
        `t b bad3 - ext::sh -c touch% ${marker}`,
        `t b bad4 - http://example.invalid/x.git`,
        `t .. dots - ${originUrl}`,
      ].join('\n') + '\n',
    );
    const r = runSync();
    expect(r.code, r.out).toBe(0);
    expect(git(join(root, 'work', 't', 'b', 'onbranch'), ['branch', '--show-current']).stdout.trim()).toBe('dev');
    expect(readdirSync(join(root, 'work', 't', 'b')).sort()).toEqual(['onbranch', 'proj']);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a file address unless the test hook is set (the pod accepts https only)', () => {
    const r = runSync({ REPO_SYNC_FILE_ADDRESSES: '' });
    expect(r.out).toMatch(/not an https address/);
    expect(existsSync(clone)).toBe(false);
  });

  it('a garbled failure mark in the shared scratch cannot stop the script', () => {
    mkdirSync(join(root, 'scratch', 'state'), { recursive: true });
    writeFileSync(join(root, 'scratch', 'state', 'failed.t.b.proj'), 'x y (\n');
    const r = runSync({ REPO_SYNC_RETRY_AFTER: '60' });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(clone, '.git'))).toBe(true);
  });
});

type Attack = { name: string; plant: () => void; control: boolean; env?: () => NodeJS.ProcessEnv };
const cfg = (text: string) => appendFileSync(join(clone, '.git', 'config'), text);
const attacks: Attack[] = [
  {
    name: 'remote.origin.uploadpack',
    control: true,
    plant: () => cfg(`[remote "origin"]\n\tuploadpack = ${hook(join(root, 'up.sh'))} #\n`),
  },
  {
    name: 'a hooks folder (core.hooksPath) with a reference-transaction hook',
    control: true,
    plant: () => {
      mkdirSync(join(root, 'hk'));
      hook(join(root, 'hk', 'reference-transaction'));
      cfg(`[core]\n\thooksPath = ${join(root, 'hk')}\n`);
    },
  },
  { name: 'a reference-transaction file in .git/hooks', control: true, plant: () => hook(join(clone, '.git', 'hooks', 'reference-transaction')) },
  {
    name: 'an include of a file that sets remote.origin.uploadpack',
    control: true,
    plant: () => {
      writeFileSync(join(root, 'inc'), `[remote "origin"]\n\tuploadpack = ${hook(join(root, 'inc.sh'))} #\n`);
      cfg(`[include]\n\tpath = ${join(root, 'inc')}\n`);
    },
  },
  {
    name: 'url.*.insteadOf to an ext:: address (protocol.ext.allow=always)',
    control: true,
    plant: () => cfg(`[protocol "ext"]\n\tallow = always\n[url "ext::sh -c touch% ${marker}"]\n\tinsteadOf = ${originUrl}\n`),
  },
  {
    name: 'core.sshCommand with url.*.insteadOf to an ssh:// address',
    control: true,
    plant: () => cfg(`[core]\n\tsshCommand = ${hook(join(root, 'ssh.sh'))}\n[url "ssh://nowhere.invalid/x"]\n\tinsteadOf = ${originUrl}\n`),
  },
  {
    name: 'core.fsmonitor',
    control: true,
    plant: () => cfg(`[core]\n\tfsmonitor = ${hook(join(root, 'fsm.sh'))}\n`),
  },
  {
    name: 'gc.auto with a pre-auto-gc hook',
    control: true,
    plant: () => {
      hook(join(clone, '.git', 'hooks', 'pre-auto-gc'));
      cfg(`[gc]\n\tauto = 1\n\tautoPackLimit = 1\n\tautoDetach = false\n[fetch]\n\tunpackLimit = 1\n`);
    },
  },
  {
    name: 'GIT_CONFIG_COUNT in the environment of the caller (core.hooksPath to a hooks folder)',
    control: true,
    plant: () => {
      mkdirSync(join(root, 'hk'));
      hook(join(root, 'hk', 'reference-transaction'));
    },
    env: () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(root, 'hk') }),
  },
  {
    name: 'GIT_EXEC_PATH in the environment of the caller (a fake git-upload-pack first)',
    control: true,
    plant: () => {
      hook(join(root, 'ex', 'git-upload-pack'));
    },
    env: () => ({ GIT_EXEC_PATH: join(root, 'ex') }),
  },
];

describe('a clone the bot has written to', () => {
  beforeEach(() => {
    expect(runSync().code).toBe(0); // the legit first clone
    expect(remoteRef()).toMatch(/^[0-9a-f]{40}$/);
    // fetch work for the second round, and enough loose objects for an automatic gc to want to run
    for (let i = 0; i < 3; i++) commitTo(origin, `n${i}.txt`, `n${i}\n`);
  });
  for (const a of attacks) {
    describe(a.name, () => {
      it('control: plain `git fetch origin` in the clone is exactly how the old script ran it', () => {
        a.plant();
        git(clone, ['fetch', '--quiet', 'origin'], a.env?.() ?? {});
        expect(existsSync(marker), 'the attack does not start a program with plain git').toBe(a.control);
      });
      it('repo-sync starts nothing, and still brings in the origin’s new commits', () => {
        a.plant();
        const want = git(origin, ['rev-parse', 'main']).stdout.trim();
        const r = runSync(a.env?.() ?? {});
        expect(r.code, r.out).toBe(0);
        expect(existsSync(marker), 'a hostile program ran').toBe(false);
        expect(remoteRef()).toBe(want);
        expect(hasObject(clone, want)).toBe(true);
      });
    });
  }

  it('fetches from the address on the list, not from the one an insteadOf line points to', () => {
    cfg(`[url "${evil}"]\n\tinsteadOf = ${origin}\n`);
    const want = git(origin, ['rev-parse', 'main']).stdout.trim();
    const evilHead = git(evil, ['rev-parse', 'main']).stdout.trim();
    const r = runSync();
    expect(r.code, r.out).toBe(0);
    expect(remoteRef()).toBe(want);
    expect(hasObject(clone, evilHead)).toBe(false);
  });

  it('leaves a clone alone whose origin is not the project’s address on the list (nothing is fetched from the other address, and nothing runs)', () => {
    const before = remoteRef();
    git(clone, ['remote', 'set-url', 'origin', `file://${evil}`]);
    cfg(`[remote "origin"]\n\tuploadpack = ${hook(join(root, 'up.sh'))} #\n`);
    const evilHead = git(evil, ['rev-parse', 'main']).stdout.trim();
    const r = runSync();
    expect(r.out).toMatch(/origin is not the project's address/);
    expect(existsSync(marker)).toBe(false);
    expect(remoteRef()).toBe(before);
    expect(hasObject(clone, evilHead)).toBe(false);
  });

  it('does not fetch into a clone that borrows objects from another folder', () => {
    const before = remoteRef();
    mkdirSync(join(clone, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(clone, '.git', 'objects', 'info', 'alternates'), `${join(evil, 'objects')}\n`);
    const r = runSync();
    expect(r.out).toMatch(/borrows objects/);
    expect(remoteRef()).toBe(before);
  });

  it('does not follow a link in place of the project folder, of its .git, of objects or of refs', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    // a copy of the clone sits outside /work; the links point at it
    ok(git(root, ['clone', '-q', origin, elsewhere + '/copy']));
    const copy = join(elsewhere, 'copy');
    const copyBefore = readFileSync(join(copy, '.git', 'packed-refs'), 'utf8');
    const countBefore = git(copy, ['rev-list', '--all', '--count']).stdout.trim();
    for (const what of ['dir', 'git', 'objects', 'refs']) {
      const work = join(root, 'work', 't', 'b');
      rmSync(join(work, 'proj'), { recursive: true, force: true });
      if (what === 'dir') symlinkSync(copy, join(work, 'proj'));
      else {
        ok(git(work, ['clone', '-q', origin, 'proj']));
        if (what === 'git') {
          rmSync(join(work, 'proj', '.git'), { recursive: true });
          symlinkSync(join(copy, '.git'), join(work, 'proj', '.git'));
        } else {
          rmSync(join(work, 'proj', '.git', what), { recursive: true });
          symlinkSync(join(copy, '.git', what), join(work, 'proj', '.git', what));
        }
      }
      const r = runSync();
      expect(r.out, what).toMatch(/is not a plain folder/);
      expect(lstatSync(join(work, 'proj')).isSymbolicLink() || what !== 'dir').toBe(true);
    }
    // nothing of the fetch landed in the copy (the origin has gained three commits since it was made)
    expect(git(copy, ['rev-list', '--all', '--count']).stdout.trim()).toBe(countBefore);
    expect(readFileSync(join(copy, '.git', 'packed-refs'), 'utf8')).toBe(copyBefore);
  });
});

describe('the rendered pod', () => {
  it('gives the repo-sync container a memory volume of its own, mounted in no other container (/tmp and /work are shared with the bot)', () => {
    const cfg = { ...configFrom({ MANYTHREADS_INCLUSTER_URL: 'http://manythreads-server.manythreads.svc.cluster.local:3000' }), namespace: 'bots', image: 'manythreads/claude-pod:1' };
    const runner: PodRunnerInfo = { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'w1', name: 'shared', enabled: true, node: null, maxConcurrent: null, teams: [{ id: 't1', slug: 'eng' }], allTeams: false, bots: [{ teamId: 't1', teamSlug: 'eng', botSlug: 'builder' }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a rendered Kubernetes object
    const d = buildDeployment(cfg, runner, namesFor('shared'), { replicas: 1, pushSecrets: [] }) as any;
    const mounting = d.spec.template.spec.containers.filter((c: { volumeMounts: { name: string }[] }) => c.volumeMounts.some((m) => m.name === 'repo-sync-scratch')).map((c: { name: string }) => c.name);
    expect(mounting).toEqual(['repo-sync']);
    const sync = d.spec.template.spec.containers.find((c: { name: string }) => c.name === 'repo-sync');
    expect(sync.volumeMounts).toContainEqual({ name: 'repo-sync-scratch', mountPath: REPO_SYNC_SCRATCH });
    expect(sync.env).toContainEqual({ name: 'REPO_SYNC_SCRATCH', value: REPO_SYNC_SCRATCH });
    expect(d.spec.template.spec.volumes.find((v: { name: string }) => v.name === 'repo-sync-scratch').emptyDir.medium).toBe('Memory');
    expect(REPO_SYNC_SCRATCH).not.toMatch(/^\/(tmp|work)(\/|$)/);
    expect(readFileSync(SCRIPT, 'utf8')).toContain('REPO_SYNC_SCRATCH:-' + REPO_SYNC_SCRATCH + '}');
  });
});
