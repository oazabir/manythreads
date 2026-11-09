// `mt-git`: the only git a Claude pod bot may run without a question (P19-09, security review of decision E5).
//
// A pre-approved `Bash(git diff:*)` is open-ended: `git diff --no-index <any file> /dev/null` prints a file outside the project (the shared sign-in under /state),
// `git log --output=<path>` overwrites one, `git add --pathspec-from-file` leaks one in its error text, and a bot that may write files can plant `.git/hooks/*`
// or a `core.fsmonitor`, a filter or `diff.external` line in `.git/config` and then have `git status` or `git commit` run any command. So the pod approves
// `mt-git <subcommand>` only, and this wrapper:
//   1. accepts a fixed list of subcommands, and for each a fixed list of options (anything else is refused; short abbreviations of long options are not on the list);
//   2. finds the repository itself (the nearest folder with a real `.git` folder, no `.git` link, no worktree, no alternates) and runs git with GIT_DIR and GIT_WORK_TREE
//      set to it, so no `-C`, `--git-dir`, `--work-tree` and no `core.worktree` can move it elsewhere;
//   3. refuses a path that leaves the repository (the folder of the path is resolved through links first);
//   4. reads the repository's own config as a LIST OF KEYS first and refuses to run when it holds anything but a short list of harmless keys (so no alias, filter,
//      textconv, diff.external, fsmonitor, hooksPath, pager, editor, ssh/proxy command, include, credential or gpg line is ever honoured), and also overrides the
//      dangerous ones on the command line, which wins over the file;
//   5. runs git with a fresh environment (no global or system config, no external diff, no pager, no editor, no prompt) and never with `--ext-diff`/`--textconv`.
// No push, fetch, pull, clone, reset, rebase, restore, clean, remote, config, stash, tag or branch deletion is on the list. Exit 2 means "mt-git refused"; any other
// code is git's own.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const refuse = (why) => {
  process.stderr.write(`mt-git: ${why}\n`);
  process.exit(2);
};

const GIT = ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'].find((p) => existsSync(p)) ?? '/usr/bin/git';

// ---- the option tables -------------------------------------------------------------------------------------------------------------------------------------------
// flags: exact arguments that take no value. longValue: `--name=value` or `--name value`. shortFlag/shortValue: letters of a cluster (`-am "text"`, `-n5`, `-U3`).
// patterns: whole-argument regular expressions for the few forms that do not fit.
const set = (...xs) => new Set(xs);
const DIFF_OUT = {
  flags: set('--patch', '-p', '--no-patch', '-s', '--stat', '--shortstat', '--numstat', '--summary', '--raw', '--name-only', '--name-status', '--no-color', '--no-renames', '--minimal', '--patience', '--histogram', '--ignore-all-space', '-w', '--ignore-space-change', '--ignore-space-at-eol', '--ignore-blank-lines', '--word-diff', '--find-renames', '-M', '-z', '--full-index', '--check'),
  longValue: set('--unified', '--diff-filter', '--abbrev', '--color', '--word-diff', '--find-renames', '--stat'),
  shortFlag: set('p', 's', 'w', 'b', 'z'),
  shortValue: set('U'),
  patterns: [],
};
const merge = (a, b) => ({
  flags: new Set([...a.flags, ...b.flags]),
  longValue: new Set([...a.longValue, ...b.longValue]),
  shortFlag: new Set([...a.shortFlag, ...b.shortFlag]),
  shortValue: new Set([...a.shortValue, ...b.shortValue]),
  patterns: [...a.patterns, ...b.patterns],
});
const NONE = { flags: set(), longValue: set(), shortFlag: set(), shortValue: set(), patterns: [] };

const SPECS = {
  status: {
    ...NONE,
    flags: set('-s', '--short', '-b', '--branch', '--porcelain', '--long', '-z', '--no-renames', '--renames', '-u', '-uno', '-unormal', '-uall', '--ignored', '--ahead-behind', '--no-ahead-behind', '--show-stash'),
    longValue: set('--porcelain', '--untracked-files', '--ignored'),
    shortFlag: set('s', 'b', 'z'),
    patterns: [/^--column(=\w+)?$/],
  },
  diff: merge(DIFF_OUT, { ...NONE, flags: set('--cached', '--staged', '--exit-code', '--quiet', '-b', '--relative'), shortFlag: set() }),
  log: merge(DIFF_OUT, {
    ...NONE,
    flags: set('--oneline', '--graph', '--decorate', '--no-decorate', '--abbrev-commit', '--no-abbrev-commit', '--all', '--first-parent', '--merges', '--no-merges', '--reverse', '--follow', '--date-order', '--topo-order', '--author-date-order', '-i', '--regexp-ignore-case', '--all-match', '--invert-grep', '--no-walk', '--left-right', '--cherry-pick', '--simplify-by-decoration', '--branches', '--remotes', '--tags'),
    longValue: set('--max-count', '--skip', '--since', '--until', '--after', '--before', '--author', '--committer', '--grep', '--format', '--pretty', '--date', '--decorate'),
    shortFlag: set('i'),
    shortValue: set('n', 'S', 'G'),
    patterns: [/^-\d+$/],
  }),
  show: merge(DIFF_OUT, { ...NONE, flags: set('--oneline', '--abbrev-commit', '--no-abbrev-commit', '--quiet', '-q'), longValue: set('--format', '--pretty', '--date'), shortFlag: set('q') }),
  add: {
    ...NONE,
    flags: set('-A', '--all', '--no-all', '-u', '--update', '-n', '--dry-run', '-v', '--verbose', '-N', '--intent-to-add', '--ignore-errors'),
    longValue: set(),
    shortFlag: set('A', 'u', 'n', 'v', 'N'),
    patterns: [/^--chmod=[+-]x$/],
  },
  commit: {
    ...NONE,
    flags: set('-a', '--all', '--allow-empty', '-q', '--quiet', '--no-verify', '-n', '-s', '--signoff', '--no-gpg-sign', '--no-edit', '--short', '--no-status'),
    longValue: set('--message'),
    shortFlag: set('a', 'q', 'n', 's'),
    shortValue: set('m'),
  },
  switch: { ...NONE, flags: set('-q', '--quiet'), longValue: set('--create'), shortFlag: set('q'), shortValue: set('c') },
  'rev-parse': {
    ...NONE,
    flags: set('--show-toplevel', '--is-inside-work-tree', '--show-prefix', '--show-cdup', '--is-bare-repository', '--verify', '-q', '--quiet', '--symbolic-full-name', '--abbrev-ref', '--short', '--symbolic'),
    longValue: set('--abbrev-ref', '--short'),
    shortFlag: set('q'),
  },
};

// A name given to `switch`, `switch -c`, `checkout -b`: no leading dash, no space, no path tricks.
const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/@^~{}+-]{0,199}$/;

// Parse one command's arguments against its table. Returns { opts: [...argv in order, options and positionals as given], positionals, paths (after `--`), valued }.
function parse(name, args) {
  const spec = SPECS[name];
  const out = [];
  const positionals = [];
  const afterDashes = [];
  const valued = new Map();
  let dashes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (dashes) {
      afterDashes.push(a);
      continue;
    }
    if (a === '--') {
      dashes = true;
      continue;
    }
    if (!a.startsWith('-') || a === '-') {
      positionals.push(a);
      out.push(a);
      continue;
    }
    if (spec.flags.has(a) || spec.patterns.some((p) => p.test(a))) {
      out.push(a);
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a : a.slice(0, eq);
      if (spec.longValue.has(key)) {
        if (eq !== -1) {
          out.push(a);
          valued.set(key, a.slice(eq + 1));
        } else {
          const v = args[i + 1];
          if (v === undefined) refuse(`${name}: ${key} needs a value`);
          out.push(a, v);
          valued.set(key, v);
          i++;
        }
        continue;
      }
      refuse(`${name}: the option ${key} is not allowed`);
    }
    // a cluster of short options: -am "text", -n5, -U3, -m"text"
    let j = 1;
    for (; j < a.length; j++) {
      const c = a[j];
      if (spec.shortFlag.has(c)) continue;
      if (spec.shortValue.has(c)) {
        const attached = a.slice(j + 1);
        if (attached !== '') {
          valued.set(`-${c}`, attached);
          out.push(a);
        } else {
          const v = args[i + 1];
          if (v === undefined) refuse(`${name}: -${c} needs a value`);
          valued.set(`-${c}`, v);
          out.push(a, v);
          i++;
        }
        j = a.length + 1;
        break;
      }
      refuse(`${name}: the option -${c} is not allowed`);
    }
    if (j === a.length) out.push(a);
  }
  return { out, positionals, afterDashes, valued, dashes };
}

// ---- where we are ------------------------------------------------------------------------------------------------------------------------------------------------
function findRoot(start) {
  let dir = start;
  for (;;) {
    let st = null;
    try {
      st = lstatSync(join(dir, '.git'));
    } catch {
      st = null;
    }
    if (st !== null) {
      if (st.isSymbolicLink() || !st.isDirectory()) refuse('the .git of this project is not a plain folder (a link or a file); mt-git does not follow it');
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) refuse('this folder is not inside a git project');
    dir = up;
  }
}

// The closest part of a path that exists, resolved through links, plus the rest as written.
function realish(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

const inside = (root, p) => p === root || p.startsWith(root + sep);

function checkPath(root, cwd, arg) {
  if (arg.includes('\0')) refuse('a path with a NUL character');
  if (arg.startsWith(':(')) refuse(`the path form "${arg.slice(0, 20)}" is not allowed`);
  // a path names a place; a revision such as HEAD~1 or main..feature resolves to a harmless name inside the folder. A leaf link is not followed (git never follows it).
  const abs = resolve(cwd, arg);
  const parent = realish(dirname(abs));
  if (!inside(root, parent) || !inside(root, join(parent, basename(abs)))) refuse(`the path ${arg.slice(0, 80)} is outside the project`);
}

// The repository's own config, as a list of keys (git reads the file, nothing runs). Only these are fine.
const SAFE_KEY = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath)$/,
  /^remote\.[^\n]+\.(url|fetch)$/,
  /^branch\.[^\n]+\.(remote|merge|rebase)$/,
  /^user\.(name|email)$/,
  /^init\.defaultbranch$/,
];

function checkRepo(root) {
  const gitDir = join(root, '.git');
  for (const rel of ['config.worktree', 'commondir', join('objects', 'info', 'alternates'), join('objects', 'info', 'http-alternates')]) {
    if (existsSync(join(gitDir, rel))) refuse(`the project's .git holds ${rel}, which mt-git does not allow`);
  }
  const cfg = join(gitDir, 'config');
  let st;
  try {
    st = lstatSync(cfg);
  } catch {
    refuse('the project has no .git/config');
  }
  if (!st.isFile()) refuse('the project\'s .git/config is not a plain file');
  const r = spawnSync(GIT, ['config', '--file', cfg, '--list', '--name-only', '-z'], { env: cleanEnv(null, null, false), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) refuse('the project\'s .git/config cannot be read');
  for (const key of r.stdout.split('\0').filter((k) => k !== '')) {
    if (!SAFE_KEY.some((re) => re.test(key))) refuse(`the project's .git/config has the entry "${key.slice(0, 60)}", which mt-git does not allow (it could run a program); ask a person to clean it`);
  }
}

// ---- running git ---------------------------------------------------------------------------------------------------------------------------------------------------
function cleanEnv(root, cwd, write) {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: '/nonexistent',
    XDG_CONFIG_HOME: '/nonexistent',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    GIT_OPTIONAL_LOCKS: write ? '1' : '0',
  };
  if (root !== null) {
    env.GIT_DIR = join(root, '.git');
    env.GIT_WORK_TREE = root;
  }
  // who commits: the pod may name the bot; nothing else is passed on
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    if (cwd !== null && typeof process.env[k] === 'string' && process.env[k] !== '' && !process.env[k].includes('\0')) env[k] = process.env[k];
  }
  if (cwd !== null) {
    env.GIT_AUTHOR_NAME ??= 'manythreads bot';
    env.GIT_AUTHOR_EMAIL ??= 'bot@manythreads.invalid';
    env.GIT_COMMITTER_NAME ??= env.GIT_AUTHOR_NAME;
    env.GIT_COMMITTER_EMAIL ??= env.GIT_AUTHOR_EMAIL;
  }
  return env;
}

// Config that wins over the repository's file (a command-line setting does), for anything that could start a program or reach the network.
const FIXED_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.editor=true',
  'core.sshCommand=/bin/false',
  'core.gitProxy=/bin/false',
  'core.askPass=/bin/false',
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'protocol.allow=never',
  'credential.helper=',
  'commit.gpgSign=false',
  'gpg.program=/bin/false',
  'gc.auto=0',
  'maintenance.auto=false',
  'diff.ignoreSubmodules=all',
  'status.submoduleSummary=false',
  'color.ui=false',
];

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === undefined) refuse('usage: mt-git status|diff|log|add|commit|switch|checkout -b|branch --show-current|show|rev-parse [options] [paths]');

  const cwd = realpathSync(process.cwd());
  let argv; // what goes after the subcommand name
  let write = false;
  const pathArgs = [];

  if (sub === 'branch') {
    if (rest.length !== 1 || rest[0] !== '--show-current') refuse('branch: only "mt-git branch --show-current" is allowed');
    argv = ['--show-current'];
  } else if (sub === 'checkout') {
    if (rest[0] !== '-b') refuse('checkout: only "mt-git checkout -b <new branch> [<start point>]" is allowed (use switch to move)');
    const names = rest.slice(1);
    if (names.length < 1 || names.length > 2 || !names.every((n) => BRANCH_NAME.test(n))) refuse('checkout -b: give a new branch name and at most one start point, plain names only');
    argv = ['-b', ...names];
    write = true;
  } else if (Object.hasOwn(SPECS, sub)) {
    const p = parse(sub, rest);
    argv = p.out;
    if (sub === 'switch') {
      if (p.dashes) refuse('switch: no -- form');
      const names = p.positionals;
      const created = p.valued.has('-c') || p.valued.has('--create');
      if (created && !BRANCH_NAME.test(p.valued.get('-c') ?? p.valued.get('--create') ?? '')) refuse('switch -c: the new branch name is not a plain name');
      if (names.length < (created ? 0 : 1) || names.length > 1 || !names.every((n) => BRANCH_NAME.test(n))) refuse('switch: give one branch name (plain names only)');
      write = true;
    } else if (sub === 'commit') {
      if (!p.valued.has('-m') && !p.valued.has('--message')) refuse('commit: give the text with -m "text" (no editor here)');
      write = true;
      pathArgs.push(...p.positionals, ...p.afterDashes);
      argv = [...argv, ...(p.dashes ? ['--', ...p.afterDashes] : [])];
    } else if (sub === 'rev-parse') {
      pathArgs.push(...p.positionals, ...p.afterDashes);
      argv = [...argv, ...(p.dashes ? ['--', ...p.afterDashes] : [])];
    } else {
      pathArgs.push(...p.positionals, ...p.afterDashes);
      argv = [...argv, ...(p.dashes ? ['--', ...p.afterDashes] : [])];
      write = sub === 'add';
    }
    if (sub === 'diff' || sub === 'log' || sub === 'show') argv = ['--no-ext-diff', '--no-textconv', ...argv];
    if (sub === 'diff' || sub === 'status') argv = [`--ignore-submodules=all`, ...argv];
  } else {
    refuse(`"${sub.slice(0, 40)}" is not a command mt-git runs (allowed: status, diff, log, add, commit, switch, checkout -b, branch --show-current, show, rev-parse)`);
  }

  const root = findRoot(cwd);
  checkRepo(root);
  for (const a of pathArgs) checkPath(root, cwd, a);

  const args = [];
  for (const c of FIXED_CONFIG) args.push('-c', c);
  args.push(sub, ...argv);
  const r = spawnSync(GIT, args, { cwd, env: cleanEnv(root, cwd, write), stdio: 'inherit' });
  if (r.error) refuse(`git could not run: ${r.error.code ?? 'error'}`);
  process.exit(r.status ?? (r.signal ? 1 : 0));
}

main();
