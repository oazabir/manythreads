import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBridgeConfig, GIT_TOOLS, instructionsFor, PUBLISH_TOOL } from '../src/render.ts';

// P19-09 security review: every Claude pod bot could run `git diff:*`, `git log:*`, `git add:*` ... without a question, and the open-ended prefix reached files outside the
// project (`git diff --no-index <file> /dev/null`, `git log --output=<path>`, `git add --pathspec-from-file`) and, through a hook or a config line written into `.git`, ran any
// command. The pod now approves `mt-git <subcommand>` only. These tests run the wrapper (deploy/images/claude-pod/mt-git.mjs) with real git, against made-up files that hold a
// canary string; none of them reads a real sign-in file.

const IMAGE = fileURLToPath(new URL('../../../../deploy/images/claude-pod/', import.meta.url));
const MT_GIT = join(IMAGE, 'mt-git.mjs');
const CANARY = 'CANARY-not-a-real-login-9f3a1c';

let root: string; // holds repo/ (the project), outside/ (what the bot must not reach) and marks/
let repo: string;
let outside: string;
let marker: string; // a file a hostile program would create

const CLEAN_ENV = (): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** Plain git, as the test sets things up (and as the "control": the attack really works when nothing stands in the way). */
const plain = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...CLEAN_ENV(), ...IDENT } });
const mt = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const r = spawnSync('node', [MT_GIT, ...args], { cwd: opts.cwd ?? repo, encoding: 'utf8', env: { ...CLEAN_ENV(), ...(opts.env ?? {}) } });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
const script = (name: string, body: string): string => {
  const p = join(root, 'marks', name);
  writeFileSync(p, `#!/bin/sh\ntouch ${marker}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mt-git-'));
  repo = join(root, 'repo');
  outside = join(root, 'outside');
  marker = join(root, 'marks', 'RAN');
  mkdirSync(join(root, 'marks'));
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), `${CANARY}\n`);
  mkdirSync(repo);
  expect(plain(repo, 'init', '-q', '-b', 'main').status).toBe(0);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  expect(plain(repo, 'add', 'a.txt').status).toBe(0);
  expect(plain(repo, 'commit', '-q', '-m', 'first').status).toBe(0);
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); // a change for diff, add and the filters to look at
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the allowed tool strings', () => {
  it('are `mt-git <subcommand>` forms only: none starts with plain git, and the list is exactly the one named in the docs', () => {
    for (const t of GIT_TOOLS) {
      expect(t).toMatch(/^Bash\(mt-git [a-z-]/);
      expect(t).not.toMatch(/^Bash\(git[ )]/);
    }
    expect([...GIT_TOOLS]).toEqual([
      'Bash(mt-git status:*)',
      'Bash(mt-git diff:*)',
      'Bash(mt-git log:*)',
      'Bash(mt-git show:*)',
      'Bash(mt-git rev-parse:*)',
      'Bash(mt-git add:*)',
      'Bash(mt-git commit:*)',
      'Bash(mt-git switch:*)',
      'Bash(mt-git checkout -b:*)',
      'Bash(mt-git branch --show-current)',
    ]);
  });

  it('are what every Claude profile is given, with no plain git next to them, and the publish command is still only for a publisher', () => {
    const runner = { name: 'dev', agent: 'claude', maxConcurrent: null, bots: [{ teamSlug: 'eng', botSlug: 'builder' }, { teamSlug: 'eng', botSlug: 'reviewer' }] };
    const cfg = { modelAliases: {}, codexModelAliases: {}, defaultConcurrency: 2, publisher: { enabled: true }, serverUrl: 'http://server:3000' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test builds the smallest config and runner the renderer reads
    const profiles = JSON.parse(buildBridgeConfig(cfg as any, runner as any, new Set(['eng/builder']))).profiles;
    const all = [...profiles['eng--builder'].extraAllowedTools, ...profiles['eng--reviewer'].extraAllowedTools] as string[];
    expect(all.filter((t) => /^Bash\(git\b/.test(t))).toEqual([]);
    expect(profiles['eng--builder'].extraAllowedTools).toEqual([...GIT_TOOLS, PUBLISH_TOOL]);
    expect(profiles['eng--reviewer'].extraAllowedTools).toEqual([...GIT_TOOLS]);
    // the bot is told to use the wrapper (a Claude run), and the Codex instructions are unchanged
    expect(instructionsFor('eng', 'builder')).toContain('`mt-git`');
    expect(instructionsFor('eng', 'builder', false, 'codex')).not.toContain('mt-git');
  });

  it('are installed in both pod images, and the shim runs the script with the bot-settable node variables removed', () => {
    for (const image of ['claude-pod', 'claude-pod-fake']) {
      const docker = readFileSync(join(IMAGE, '..', image, 'Dockerfile'), 'utf8');
      expect(docker, image).toMatch(/COPY mt-git\.mjs \/opt\/claude-pod\/mt-git\.mjs/);
      expect(docker, image).toMatch(/COPY mt-git\.sh \/usr\/local\/bin\/mt-git/);
      expect(docker, image).toMatch(/chmod 0755[^\n]*\/usr\/local\/bin\/mt-git/);
    }
    const shim = readFileSync(join(IMAGE, 'mt-git.sh'), 'utf8');
    expect(shim).toContain('env -u NODE_OPTIONS -u NODE_PATH node /opt/claude-pod/mt-git.mjs "$@"');
  });
});

describe('mt-git refuses what plain git would have done', () => {
  const sourceOfCanary = (r: { all: string }) => expect(r.all).not.toContain(CANARY);

  it('git diff --no-index <file outside> /dev/null: the control prints the canary, the wrapper refuses', () => {
    const secret = join(outside, 'secret.txt');
    expect(plain(repo, 'diff', '--no-index', secret, '/dev/null').stdout).toContain(CANARY); // the bug: the control shows the attack works
    for (const args of [
      ['diff', '--no-index', secret, '/dev/null'],
      ['diff', '--no-index', '--', secret, '/dev/null'],
      ['diff', '--no-ind', secret, '/dev/null'], // git accepts an abbreviation of a long option
      ['diff', secret, '/dev/null'],
      ['diff', '--', secret],
      ['log', '-p', '--', secret],
    ]) {
      const r = mt(args);
      expect(r.code, args.join(' ')).toBe(2);
      sourceOfCanary(r);
    }
  });

  it('git add --pathspec-from-file <file outside>: the control leaks the file in its error text, the wrapper refuses', () => {
    const secret = join(outside, 'secret.txt');
    expect(plain(repo, 'add', `--pathspec-from-file=${secret}`).stderr).toContain(CANARY);
    for (const args of [['add', `--pathspec-from-file=${secret}`], ['add', '--pathspec-from-file', secret], ['add', '--pathspec-file-nul', secret], ['add', '--pathspec-from', secret], ['add', secret], ['add', '-A', '--', secret]]) {
      const r = mt(args);
      expect(r.code, args.join(' ')).toBe(2);
      sourceOfCanary(r);
    }
  });

  it('git log --output=<path>: the control overwrites a file outside, the wrapper does not', () => {
    const target = join(outside, 'victim.txt');
    writeFileSync(target, 'keep me\n');
    expect(plain(repo, 'log', `--output=${target}`).status).toBe(0);
    expect(readFileSync(target, 'utf8')).not.toBe('keep me\n'); // the control overwrote it
    writeFileSync(target, 'keep me\n');
    for (const args of [['log', `--output=${target}`], ['log', '--output', target], ['log', '--out', target], ['diff', `--output=${target}`], ['show', `--output=${target}`], ['diff', '-O', target], ['commit', '-F', target]]) {
      expect(mt(args).code, args.join(' ')).toBe(2);
      expect(readFileSync(target, 'utf8'), args.join(' ')).toBe('keep me\n');
    }
  });

  it('other options that take a path, set the repository or the program, and every command that is not on the list', () => {
    const secret = join(outside, 'secret.txt');
    const refused = [
      ['-c', 'core.pager=cat', 'status'],
      ['-C', outside, 'status'],
      ['--git-dir', outside, 'status'],
      ['--git-dir=' + outside, 'status'],
      ['--work-tree', outside, 'status'],
      ['--exec-path=' + outside, 'status'],
      ['--upload-pack', 'x', 'status'],
      ['diff', '--ext-diff'],
      ['diff', '--textconv'],
      ['diff', '--no-index'],
      ['log', '--show-signature'],
      ['status', '--git-dir=' + outside],
      ['commit', '-m', 'x', '--amend'],
      ['commit', '-m', 'x', '--author=x <x@x>', '-C', 'HEAD'],
      ['commit', '--template=' + secret, '-m', 'x'],
      ['commit'],
      ['switch', '-C', 'x'],
      ['switch', '--discard-changes', 'main'],
      ['switch', '-c', '-bad'],
      ['switch', '--', 'a.txt'],
      ['checkout', 'a.txt'],
      ['checkout', '-f'],
      ['checkout', '-b', '-bad'],
      ['branch', '-D', 'main'],
      ['branch'],
      ['rev-parse', '--git-dir'],
      ['rev-parse', '--parseopt'],
      ['push'],
      ['fetch'],
      ['pull'],
      ['clone', outside],
      ['reset', '--hard'],
      ['clean', '-fd'],
      ['restore', 'a.txt'],
      ['stash'],
      ['tag', 'x'],
      ['remote', 'add', 'x', 'y'],
      ['config', 'core.fsmonitor', 'x'],
      ['rebase', 'main'],
      ['merge', 'main'],
      ['apply', secret],
      ['am', secret],
      ['grep', 'x'],
      ['submodule', 'update'],
      ['worktree', 'add', outside],
      ['ls-files'],
      ['cat-file', '-p', 'HEAD'],
      ['hash-object', '-w', secret],
      ['-h'],
      [],
    ];
    for (const args of refused) {
      const r = mt(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toMatch(/^mt-git: /);
    }
    expect(existsSync(join(outside, 'x'))).toBe(false);
  });

  it('a path that leaves the project, by ../, by an absolute path or through a link inside the project', () => {
    symlinkSync(outside, join(repo, 'link')); // a link to a folder outside
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'leaf-link'));
    mkdirSync(join(repo, 'sub'));
    for (const [args, cwd] of [
      [['diff', '--', '../outside/secret.txt'], repo],
      [['diff', '--', '../../outside/secret.txt'], join(repo, 'sub')],
      [['add', join(outside, 'secret.txt')], repo],
      [['add', 'link/secret.txt'], repo],
      [['diff', '--', 'link/secret.txt'], repo],
      [['log', '-p', 'link/secret.txt'], repo],
      [['status', 'link/secret.txt'], repo],
      [['show', ':(top)../outside/secret.txt'], repo],
      [['add', ':(glob)**'], repo],
    ] as [string[], string][]) {
      const r = mt(args, { cwd });
      expect(r.code, args.join(' ')).toBe(2);
      sourceOfCanary(r);
    }
    // the link itself is only a link: git stores where it points, never the file it points to, and mt-git does not refuse a link that is part of the project
    expect(mt(['add', 'leaf-link']).code).toBe(0);
    expect(plain(repo, 'show', ':leaf-link').stdout).not.toContain(CANARY);
  });

  it('refuses a project whose .git is a link, a file, an alternate or a worktree, and a folder that is no project', () => {
    const base = join(root, 'plain');
    mkdirSync(base);
    expect(mt(['status'], { cwd: base }).code).toBe(2);
    const gitdir = join(root, 'elsewhere.git');
    expect(plain(root, 'init', '-q', '--bare', gitdir).status).toBe(0);
    const linked = join(root, 'linked');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), `gitdir: ${gitdir}\n`);
    expect(mt(['status'], { cwd: linked }).code).toBe(2);
    const sym = join(root, 'symgit');
    mkdirSync(sym);
    symlinkSync(join(repo, '.git'), join(sym, '.git'));
    expect(mt(['status'], { cwd: sym }).code).toBe(2);
    mkdirSync(join(repo, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(outside, 'objects')}\n`);
    expect(mt(['status']).code).toBe(2);
    rmSync(join(repo, '.git', 'objects', 'info', 'alternates'));
    expect(mt(['status']).code).toBe(0);
    writeFileSync(join(repo, '.git', 'commondir'), `${outside}\n`);
    expect(mt(['status']).code).toBe(2);
  });
});

describe('a hostile .git is never run', () => {
  // each case: lines for .git/config, optional .gitattributes, whether plain git runs it (the control) and by which command
  interface Attack {
    name: string;
    config: (p: { prog: string; marker: string; outside: string }) => string;
    attributes?: string;
    control?: string[]; // plain git command that runs the planted program
  }
  const attacks: Attack[] = [
    { name: 'core.fsmonitor', config: ({ prog }) => `[core]\n\tfsmonitor = ${prog}\n`, control: ['status'] },
    { name: 'filter clean driver', config: ({ prog }) => `[filter "x"]\n\tclean = ${prog}\n`, attributes: 'a.txt filter=x\n', control: ['add', 'a.txt'] },
    { name: 'filter smudge and process drivers', config: ({ prog }) => `[filter "x"]\n\tsmudge = ${prog}\n\tprocess = ${prog}\n`, attributes: 'a.txt filter=x\n' },
    { name: 'diff.external', config: ({ prog }) => `[diff]\n\texternal = ${prog}\n`, control: ['diff'] },
    { name: 'diff driver textconv', config: ({ prog }) => `[diff "x"]\n\ttextconv = ${prog}\n`, attributes: 'a.txt diff=x\n', control: ['diff'] },
    { name: 'diff driver command', config: ({ prog }) => `[diff "x"]\n\tcommand = ${prog}\n`, attributes: 'a.txt diff=x\n' },
    { name: 'merge driver', config: ({ prog }) => `[merge "x"]\n\tdriver = ${prog}\n`, attributes: 'a.txt merge=x\n' },
    { name: 'core.hooksPath', config: ({ outside }) => `[core]\n\thooksPath = ${outside}/hooks\n`, control: ['commit', '-q', '-a', '-m', 'x'] },
    { name: 'an alias', config: ({ prog }) => `[alias]\n\tstatus = !${prog}\n\tdiff = !${prog}\n\tcommit = !${prog}\n\tadd = !${prog}\n` },
    { name: 'core.pager', config: ({ prog }) => `[core]\n\tpager = ${prog}\n` },
    { name: 'core.editor', config: ({ prog }) => `[core]\n\teditor = ${prog}\n` },
    { name: 'core.sshCommand', config: ({ prog }) => `[core]\n\tsshCommand = ${prog}\n` },
    { name: 'core.gitProxy', config: ({ prog }) => `[core]\n\tgitProxy = ${prog}\n` },
    { name: 'a credential helper', config: ({ prog }) => `[credential]\n\thelper = ${prog}\n` },
    { name: 'gpg.program with signing on', config: ({ prog }) => `[gpg]\n\tprogram = ${prog}\n[commit]\n\tgpgsign = true\n` },
    { name: 'an include of a file outside', config: ({ outside }) => `[include]\n\tpath = ${outside}/more.config\n` },
    { name: 'core.worktree set to a folder outside', config: ({ outside }) => `[core]\n\tworktree = ${outside}\n` },
    { name: 'extensions.worktreeConfig', config: () => '[extensions]\n\tworktreeConfig = true\n' },
    { name: 'a remote with an uploadpack program', config: ({ prog }) => `[remote "origin"]\n\turl = ${prog}\n\tuploadpack = ${prog}\n` },
    { name: 'a submodule', config: ({ prog }) => `[submodule "s"]\n\turl = ${prog}\n\tactive = true\n` },
  ];

  for (const attack of attacks) {
    it(`${attack.name}: status, diff, log -p, add and commit all refuse and nothing is started`, () => {
      const prog = script('prog.sh', 'cat');
      mkdirSync(join(outside, 'hooks'));
      writeFileSync(join(outside, 'more.config'), '[user]\n\tname = x\n');
      writeFileSync(join(outside, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(join(outside, 'hooks', 'pre-commit'), 0o755);
      appendFileSync(join(repo, '.git', 'config'), attack.config({ prog, marker, outside }));
      if (attack.attributes !== undefined) writeFileSync(join(repo, '.gitattributes'), attack.attributes);
      // the control: plain git runs the planted program (so a green test below means the wrapper stood in the way, not that the setup was wrong)
      if (attack.control !== undefined) {
        plain(repo, ...attack.control);
        expect(existsSync(marker), 'plain git should run it').toBe(true);
        rmSync(marker);
      }
      for (const args of [['status'], ['status', '-s'], ['diff'], ['diff', '--cached'], ['log', '-p'], ['show'], ['add', 'a.txt'], ['add', '-A'], ['commit', '-a', '-m', 'x'], ['rev-parse', 'HEAD'], ['switch', '-c', 'card-12345678'], ['branch', '--show-current']]) {
        const r = mt(args);
        expect(r.code, `${attack.name}: mt-git ${args.join(' ')}\n${r.all}`).toBe(2);
        expect(r.err).toContain('does not allow');
        expect(existsSync(marker), `${attack.name}: ${args.join(' ')} ran the planted program`).toBe(false);
      }
    });
  }

  it('a hook in .git/hooks is never run (pre-commit, post-commit, commit-msg, fsmonitor-watchman, reference-transaction), and the commit still works', () => {
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const h of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'reference-transaction', 'fsmonitor-watchman', 'pre-auto-gc', 'post-index-change']) {
      writeFileSync(join(hooks, h), `#!/bin/sh\ntouch ${marker}\nexit 0\n`);
      chmodSync(join(hooks, h), 0o755);
    }
    // control: plain git runs them
    plain(repo, 'commit', '-q', '-a', '-m', 'plain');
    expect(existsSync(marker), 'plain git should run the hook').toBe(true);
    rmSync(marker);
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    for (const args of [['add', '-A'], ['commit', '-m', 'via wrapper'], ['switch', '-c', 'card-87654321'], ['status'], ['diff'], ['log']]) {
      const r = mt(args);
      expect(r.code, `${args.join(' ')}\n${r.all}`).toBe(0);
    }
    expect(existsSync(marker)).toBe(false);
    expect(plain(repo, 'log', '--format=%s', '-1').stdout.trim()).toBe('via wrapper');
  });

  it('environment variables a caller sets (external diff, pager, editor, git directory, extra config, ssh) are not passed to git', () => {
    const prog = script('envprog.sh', 'cat');
    const env = {
      GIT_EXTERNAL_DIFF: prog,
      GIT_PAGER: prog,
      PAGER: prog,
      GIT_EDITOR: prog,
      EDITOR: prog,
      GIT_SSH_COMMAND: prog,
      GIT_DIR: outside,
      GIT_WORK_TREE: outside,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: prog,
      GIT_CONFIG_KEY_1: 'diff.external',
      GIT_CONFIG_VALUE_1: prog,
      GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${prog}'`,
      GIT_CONFIG_GLOBAL: join(outside, 'more.config'),
    };
    // control: plain git given the same variables does run it
    const c = spawnSync('git', ['diff'], { cwd: repo, encoding: 'utf8', env: { ...CLEAN_ENV(), GIT_EXTERNAL_DIFF: prog } });
    expect(c.status).toBe(0);
    expect(existsSync(marker), 'plain git should run it').toBe(true);
    rmSync(marker);
    for (const args of [['diff'], ['status'], ['log', '-p'], ['add', '-A'], ['commit', '-m', 'x']]) {
      const r = mt(args, { env });
      expect(r.code, `${args.join(' ')}\n${r.all}`).toBe(0);
    }
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(outside).sort()).toEqual(['secret.txt']);
  });

  it('a filter or diff attribute in the project with no matching config does nothing', () => {
    writeFileSync(join(repo, '.gitattributes'), 'a.txt filter=x diff=x merge=x export-subst\n');
    expect(mt(['diff']).code).toBe(0);
    expect(mt(['add', '-A']).code).toBe(0);
    expect(mt(['commit', '-m', 'with attributes']).code).toBe(0);
  });
});

describe('what a bot is meant to do still works', () => {
  it('status, diff, add, commit, log, show, rev-parse, switch, checkout -b and branch --show-current, from the project folder and from inside it', () => {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'b.txt'), 'b\n');
    expect(mt(['status', '--short']).out).toMatch(/M a\.txt/);
    expect(mt(['status', '-sb']).out).toContain('## main');
    const d = mt(['diff']);
    expect(d.code).toBe(0);
    expect(d.out).toContain('+two');
    expect(mt(['diff', '--stat', '--', 'a.txt']).out).toContain('a.txt');
    expect(mt(['diff', '-U1', 'a.txt']).code).toBe(0);
    expect(mt(['switch', '-c', 'card-1a2b3c4d']).code).toBe(0);
    expect(mt(['branch', '--show-current']).out.trim()).toBe('card-1a2b3c4d');
    expect(mt(['add', 'a.txt', 'src/b.txt']).code).toBe(0);
    expect(mt(['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean)).toEqual(['a.txt', 'src/b.txt']);
    // from a subfolder, with a path that goes up and stays inside
    writeFileSync(join(repo, 'src', 'c.txt'), 'c\n');
    expect(mt(['add', '../src/c.txt'], { cwd: join(repo, 'src') }).code).toBe(0);
    const c = mt(['commit', '-m', 'Add the files with "quotes" and a - dash'], { cwd: join(repo, 'src') });
    expect(c.code, c.all).toBe(0);
    expect(mt(['log', '--oneline', '-n', '2']).out.split('\n').filter(Boolean)).toHaveLength(2);
    expect(mt(['log', '-1', '--format=%s']).out.trim()).toBe('Add the files with "quotes" and a - dash');
    expect(mt(['log', '-5', '--stat']).code).toBe(0);
    expect(mt(['show', '--stat', 'HEAD']).out).toContain('src/c.txt');
    expect(mt(['show', 'HEAD:src/c.txt']).out).toBe('c\n');
    expect(mt(['rev-parse', 'HEAD']).out.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(mt(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()).toBe('card-1a2b3c4d');
    expect(mt(['rev-parse', '--show-toplevel']).out.trim()).toBe(realpathSync(repo));
    expect(mt(['switch', 'main']).code).toBe(0);
    expect(mt(['checkout', '-b', 'card-deadbeef']).code).toBe(0);
    expect(mt(['branch', '--show-current']).out.trim()).toBe('card-deadbeef');
    // a branch name given to commit's -am form
    writeFileSync(join(repo, 'a.txt'), 'changed again\n');
    const am = mt(['commit', '-am', 'all in one']);
    expect(am.code, am.all).toBe(0);
    expect(mt(['status', '--porcelain']).out).toBe('');
    // the commit says who made it even when the pod sets no identity
    expect(plain(repo, 'log', '-1', '--format=%an').stdout.trim()).toBe('manythreads bot');
  });

  it('keeps the exit code of git (a diff --exit-code on a change is 1), and uses the pod\'s identity when it sets one', () => {
    expect(mt(['diff', '--exit-code', '--quiet']).code).toBe(1);
    expect(mt(['commit', '-a', '-m', 'x'], { env: { GIT_AUTHOR_NAME: 'Builder', GIT_AUTHOR_EMAIL: 'builder@example.test' } }).code).toBe(0);
    expect(plain(repo, 'log', '-1', '--format=%an <%ae>').stdout.trim()).toBe('Builder <builder@example.test>');
    expect(mt(['diff', '--exit-code', '--quiet']).code).toBe(0);
  });

  it('works through the shim the images install', () => {
    // the shim names /opt/claude-pod/mt-git.mjs, which exists only in the image: the same script is run here with the shim's own env scrubbing
    const r = spawnSync('env', ['-u', 'NODE_OPTIONS', '-u', 'NODE_PATH', 'node', MT_GIT, 'status', '-s'], { cwd: repo, encoding: 'utf8', env: { ...CLEAN_ENV(), NODE_OPTIONS: '--no-such-flag' } });
    expect(r.status).toBe(0);
  });
});
