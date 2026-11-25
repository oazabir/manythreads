import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, type Stats, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { posix } from 'node:path';
import { RUN_OOM_SCORE } from './memory-watch.ts';
import { acceptRenewed, accountOf, CODEX_AUTH_MAX_BYTES, codexTokenFacts, mainIsNewer, rebuildRenewed, refusalLine, type CodexTokenFacts } from './codex-token.ts';
import { AGENTS_GROUP, isKind, isRunTag, isSlug, KINDS, launchEnv, MAX_HEADER_BYTES, parseHeader, RUNS_SLICE, runScopeUnit, teamCodexHome, teamHome, teamSigninDir, teamSigninRoot, teamUserName, type Kind, type LaunchHeader } from './team-user.ts';

// The root helper of an enrolled server (PLAN P26-22, docs/plans/agents-anywhere.md section 9b). The installer puts a copy at /opt/manythreads-bridge/helper/ (root's, 0755) and a sudoers
// rule that lets the bridge's user run exactly two commands of it:
//
//   mt-team-helper ensure-user <team>        make the team's user `mt-team-<team>` and its home (idempotent)
//   mt-team-helper run <team> <kind>         start one fixed program as that user: <kind> is claude, codex, hermes (the adapters), sync (the repository sync), clean-kube, clean-codex, or one
//                                            of the kinds of a team's own sign-in (claude-login, claude-logout, codex-key, codex-logout, clean-signin; P35-10b)
//
// Everything the sudoers rule cannot say (it only matches words) is checked here: the slug, the kind, that there are no more arguments. The programs come from a table the installer
// wrote as root (`/etc/manythreads-bridge/team-agents.json`): the bridge names a kind, never a program. The run's environment, the files it needs and the working folder come on the
// FIRST LINE OF STANDARD INPUT as JSON (never in an argument: a command line is readable by every user on the machine), are checked by `parseHeader`, and the rest of standard input
// is handed on to the program untouched: the adapter's own protocol. The run token is therefore in the program's environment only.
//
// Rules this file keeps, because it runs as root over folders that a team user can write into:
//   - what is made or changed as root lies in folders that no team user can write: `<root>/work` (root's, checked) and the new home right after it is made. Everything a team's own files
//     need (its work folder, the kube folder, a file) is made by a program started AS that user (`setpriv`), so a link planted in a home cannot make root write somewhere else;
//   - Claude's sign-in folder is shared on purpose (group `mt-agents`); the only thing done there as root is fixing the group and the group bits of the files in it, on an open
//     file descriptor that is not a link and has one name (`O_NOFOLLOW`, `nlink` 1), so a link or a hard link planted there is left alone;
//   - Codex's sign-in (P31-01) is the bridge user's alone (`<root>/auth/codex`, 0700). For a Codex run it is copied into the team's own Codex home and a renewed copy is copied back:
//     every read and write of the main copy runs AS the bridge user and every read and write of the team's copy AS the team user (`setpriv`), so root never opens a file a team or the
//     bridge controls. What root itself makes lies in `<root>/auth/.locks` (root's, 0700): the lock (`flock`), the live markers, the one-time markers.

export const CONFIG_FILE = '/etc/manythreads-bridge/team-agents.json';
export const NOLOGIN_SHELLS = ['/usr/sbin/nologin', '/sbin/nologin', '/usr/bin/nologin', '/bin/false'];
const SYSTEM_PATH = '/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface AgentProgram {
  command: string;
  args: string[];
  /** Codex only: the `codex` program itself (the adapter is `command`), for the API-key sign-in and the sign-out of a team's own sign-in (P35-10b). Absent: those two kinds are refused. */
  cli?: string | undefined;
}

export interface HelperConfig {
  /** The bridge's data folder (`server.root`). */
  dataRoot: string;
  agents: Partial<Record<'claude' | 'codex' | 'hermes', AgentProgram>>;
  /** The pod's `repo-sync.sh` (from the release's tools folder), run with `sh`. */
  syncScript?: string | undefined;
  /** The group of the publisher service; the team home belongs to it (mode 2750) so the publisher can read a bot's clone. Absent: the home is 0700. */
  publisherGroup?: string | undefined;
  /** The group that may open the publisher's socket (the publisher runs with it as its group): every team user joins it, nobody else is in it (P26-19). Absent: no one is added. */
  publishClientsGroup?: string | undefined;
  /** The bridge's own user, who owns the machine's Codex sign-in (`<root>/auth/codex`): the helper reads and writes that copy as this user, never as root (P31-01). Absent: no Codex run starts. */
  bridgeUser?: string | undefined;
  /**
   * A systemd scope per run (P31-04, docs/plans/codex-teams-and-oom.md section 3): written by the installer only on a machine with `systemd-run` and systemd 253 or later (`OOMPolicy=`
   * on a scope). Absent: runs start as before, weighted by `oom_score_adj` only.
   */
  runScope?: RunScope | undefined;
}

export interface RunScope {
  /** The absolute path of `systemd-run`. */
  systemdRun: string;
  /** The most memory one run may use, in bytes (`MemoryMax` of its scope): the installer's `--run-memory`, at most 4 GiB (the Helm maximum of a run pod). */
  memoryMaxBytes: number;
  /** The bridge's own unit: the scope is bound to it (`BindsTo=`), so a stopped bridge stops every run it started. Absent: not bound. */
  bindsTo?: string | undefined;
}

/** A run may never be given more than this (the Helm maximum of a run pod's container, plan section 3 (4)). */
export const RUN_MEMORY_MAX_BYTES = 4 * 1024 ** 3;
/** Nor less than this: a limit that small is a typing mistake, and every run would fail. */
export const RUN_MEMORY_MIN_BYTES = 256 * 1024 ** 2;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const absolute = (v: unknown): v is string => typeof v === 'string' && posix.isAbsolute(v) && posix.normalize(v) === v && !v.includes('\0') && !v.endsWith('/') && v.length > 1;

/** The table the installer writes; anything that is not a plain table is refused (the helper then does nothing). */
export function parseHelperConfig(text: string): HelperConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('the helper table is not JSON');
  }
  if (!isRecord(raw) || !absolute(raw['dataRoot'])) throw new Error('the helper table needs an absolute dataRoot');
  const agentsRaw = raw['agents'];
  if (!isRecord(agentsRaw)) throw new Error('the helper table needs agents');
  const agents: HelperConfig['agents'] = {};
  for (const [k, v] of Object.entries(agentsRaw)) {
    if (k !== 'claude' && k !== 'codex' && k !== 'hermes') throw new Error(`the helper table has an unknown agent ${k.slice(0, 20)}`);
    if (!isRecord(v) || !absolute(v['command']) || (v['args'] !== undefined && (!Array.isArray(v['args']) || v['args'].some((a) => typeof a !== 'string' || a.includes('\0'))))) throw new Error(`the helper table's ${k} needs an absolute command`);
    if (v['cli'] !== undefined && (k !== 'codex' || !absolute(v['cli']))) throw new Error(`the helper table's ${k} cli must be an absolute path (Codex only)`);
    agents[k] = { command: v['command'], args: (v['args'] as string[] | undefined) ?? [], ...(typeof v['cli'] === 'string' ? { cli: v['cli'] } : {}) };
  }
  const sync = raw['syncScript'];
  if (sync !== undefined && !absolute(sync)) throw new Error('syncScript must be an absolute path');
  const pub = raw['publisherGroup'];
  if (pub !== undefined && (typeof pub !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(pub))) throw new Error('publisherGroup must be a group name');
  const clients = raw['publishClientsGroup'];
  if (clients !== undefined && (typeof clients !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(clients))) throw new Error('publishClientsGroup must be a group name');
  const bridgeUser = raw['bridgeUser'];
  if (bridgeUser !== undefined && (typeof bridgeUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(bridgeUser) || bridgeUser === 'root')) throw new Error('bridgeUser must be a user name other than root');
  const scopeRaw = raw['runScope'];
  let runScope: RunScope | undefined;
  if (scopeRaw !== undefined) {
    if (!isRecord(scopeRaw) || !absolute(scopeRaw['systemdRun'])) throw new Error('runScope needs the absolute path of systemd-run');
    const max = scopeRaw['memoryMaxBytes'];
    if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < RUN_MEMORY_MIN_BYTES || max > RUN_MEMORY_MAX_BYTES) throw new Error('runScope.memoryMaxBytes must be a whole number of bytes from 256 MiB to 4 GiB');
    const binds = scopeRaw['bindsTo'];
    if (binds !== undefined && (typeof binds !== 'string' || !/^[a-zA-Z0-9@_.-]{1,200}\.service$/.test(binds))) throw new Error('runScope.bindsTo must be a service name');
    runScope = { systemdRun: scopeRaw['systemdRun'], memoryMaxBytes: max, ...(typeof binds === 'string' ? { bindsTo: binds } : {}) };
  }
  return {
    dataRoot: raw['dataRoot'],
    agents,
    ...(runScope !== undefined ? { runScope } : {}),
    ...(typeof sync === 'string' ? { syncScript: sync } : {}),
    ...(typeof pub === 'string' ? { publisherGroup: pub } : {}),
    ...(typeof clients === 'string' ? { publishClientsGroup: clients } : {}),
    ...(typeof bridgeUser === 'string' ? { bridgeUser } : {}),
  };
}

export type Parsed = { ok: true; command: 'ensure-user'; team: string } | { ok: true; command: 'run'; team: string; kind: Kind } | { ok: false; error: string };

/** The helper's own words, after the sudoers rule matched: exactly `ensure-user <team>` or `run <team> <kind>`, nothing more. */
export function parseArgv(argv: readonly string[]): Parsed {
  const [command, team, kind, ...rest] = argv;
  if (command === 'ensure-user' && isSlug(team) && kind === undefined) return { ok: true, command, team };
  if (command === 'run' && isSlug(team) && isKind(kind) && rest.length === 0) return { ok: true, command, team, kind };
  if (command !== 'ensure-user' && command !== 'run') return { ok: false, error: 'the commands are ensure-user <team> and run <team> <kind>' };
  if (!isSlug(team)) return { ok: false, error: 'that is not a team slug (lower case letters, digits and single dashes, at most 63 characters)' };
  return { ok: false, error: command === 'run' ? `the kinds are ${KINDS.slice(0, -1).join(', ')} and ${KINDS[KINDS.length - 1]}, and nothing follows them` : 'nothing follows the team in ensure-user' };
}

/** One argument for a POSIX shell: single quotes, and a quote inside closed and reopened (the same rule as the bridge's own terminal, acp/pty.ts). */
const shQuote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/** Where `script` (util-linux) may be. */
export const SCRIPT_PATHS = ['/usr/bin/script', '/bin/script'];

/**
 * A program that insists on a terminal, under one `script` makes, AS the team user (P35-10b, plan section 7): the helper has already read the header from the pipe, so the header never
 * reaches a terminal and its echo cannot show it. The command line is built only from the helper's own table (root's file) and constant words. `-e` ends `script` with the program's
 * own exit code (measured: without it a failed sign-in looks like a good one); the terminal is 500 columns wide so a long sign-in address is printed on one line.
 */
export function underTerminal(script: string, argv: readonly string[]): string[] {
  const line = `stty cols 500 rows 50 2>/dev/null; exec ${argv.map(shQuote).join(' ')}`;
  return [script, '-q', '-e', '-f', '-c', `/bin/sh -c ${shQuote(line)}`, '/dev/null'];
}

/** The program a kind starts, from the table: the command and its arguments, and the umask it runs with. `null` for a kind that starts none (clean-kube, clean-codex, clean-signin). */
export function programFor(cfg: HelperConfig, kind: Kind, script: string | null = null): { argv: string[]; umask: string } | null {
  if (kind === 'clean-kube' || kind === 'clean-codex' || kind === 'clean-signin' || kind === 'signin-facts') return null;
  if (kind === 'sync') {
    if (cfg.syncScript === undefined) throw new Error('this machine has no repository sync script');
    return { argv: ['/bin/sh', cfg.syncScript], umask: '0027' };
  }
  if (kind === 'claude-login' || kind === 'claude-logout') {
    const p = cfg.agents.claude;
    if (p === undefined) throw new Error('this machine has no claude agent');
    if (script === null) throw new Error('script is needed for a Claude sign-in (the util-linux package)');
    // the adapter's own Claude program: the measured sign-in (`--cli auth login --claudeai`) and sign-out (`--cli auth logout`), docs/spikes/acp-measured.md
    const words = kind === 'claude-login' ? ['--cli', 'auth', 'login', '--claudeai'] : ['--cli', 'auth', 'logout'];
    return { argv: underTerminal(script, [p.command, ...p.args, ...words]), umask: '0077' };
  }
  if (kind === 'codex-key' || kind === 'codex-logout') {
    const cli = cfg.agents.codex?.cli;
    if (cli === undefined) throw new Error('this machine has no codex program in the helper table (run the installer again with --update)');
    // the key is read by `codex login --with-api-key` from standard input: the rest of the pipe after the header, never an argument or a variable
    return { argv: kind === 'codex-key' ? [cli, 'login', '--with-api-key'] : [cli, 'logout'], umask: '0077' };
  }
  const p = cfg.agents[kind];
  if (p === undefined) throw new Error(`this machine has no ${kind} agent`);
  return { argv: [p.command, ...p.args], umask: '0007' };
}

// The three small programs run AS the team user. They are constants: nothing from a header is ever part of a program text, only an argument of it.
export const SH_MKDIR = 'umask "$1"; shift; mkdir -p -- "$@"';
export const SH_PUT = 'umask 077; d=$(dirname -- "$1") && mkdir -p -- "$d" && rm -rf -- "$1.new" && cat > "$1.new" && chmod "$2" "$1.new" && mv -f -- "$1.new" "$1"';
export const SH_RM = 'rm -rf -- "$@"';
/** Removes a folder only when it is empty (the team's `.signin` after its last sign-in folder went). */
export const SH_RMDIR = 'rmdir -- "$1" 2>/dev/null || true';
export const SH_EXEC = 'umask "$1"; shift; cd -- "$1" && shift && exec "$@"';
/** A folder only its user may enter (the team's Codex home): made with umask 077 and set to 0700; the leading 00 also clears a setgid bit (GNU chmod keeps it on a folder for 0700). */
export const SH_PRIVATE_DIR = 'umask 077; mkdir -p -- "$1" && chmod 00700 -- "$1"';
/**
 * Reads a sign-in file, bounded: one byte over the limit shows that it is too big, and `timeout 2` ends a read that blocks (a FIFO planted in place of the file), so the 15 second watch
 * of a run is never frozen (review correction 5). Run as the file's owner (the team user for its copy, the bridge user for the main copy). A missing file (no name at all) exits 3.
 */
export const SH_READ = `[ -e "$1" ] || [ -L "$1" ] || exit 3; exec timeout 2 head -c ${CODEX_AUTH_MAX_BYTES + 1} -- "$1"`;
/** The exit code of SH_READ for "there is no such file" (a sign-out), told apart from a read that failed or timed out. */
export const SH_READ_MISSING = 3;
/** Replaces a file in one step as its owner: a new file of 0600 written from standard input, flushed to disk, then renamed over the old one (the main Codex copy, as the bridge user). */
export const SH_REPLACE = 'umask 077; cat > "$1.new" && chmod 0600 -- "$1.new" && { sync -- "$1.new" 2>/dev/null || true; } && mv -f -T -- "$1.new" "$1"';

/** The kernel's out-of-memory weight of this process: -1000 (never) to 1000 (first). */
export const OOM_SCORE_FILE = '/proc/self/oom_score_adj';
export { RUN_OOM_SCORE };

export interface OomScoreFile {
  read(): string;
  write(text: string): void;
}

const procOomScore: OomScoreFile = {
  read: () => readFileSync(OOM_SCORE_FILE, 'utf8'),
  write: (text) => {
    const fd = openSync(OOM_SCORE_FILE, constants.O_WRONLY);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  },
};

const oomValue = (text: string): number | null => {
  const t = text.trim();
  if (!/^-?\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= -1000 && n <= 1000 ? n : null;
};

/**
 * Called as root right before the program is spawned (P31-04, plan correction 6). Root writes 1000 on the helper itself: a write by a process that may raise and lower the value
 * (CAP_SYS_RESOURCE) also sets the floor `oom_score_adj_min`, and the spawned program inherits both, so the team's program (no longer root after `setpriv`) cannot lower its own value,
 * not even by one, and cannot make the database the victim instead. `restore` then puts the helper's own value back (root may lower it; measured on the devbox, 2026-11-20), so the
 * helper, which ends the run's group and removes its folders, is not the first to go. Never throws: a machine that refuses the write runs the program as before.
 */
export function raiseForChild(file: OomScoreFile = procOomScore): { raised: boolean; restore: () => boolean } {
  let before = 0;
  try {
    before = oomValue(file.read()) ?? 0;
  } catch {
    /* unreadable: put back 0, the value a process normally has */
  }
  let raised = false;
  try {
    file.write(String(RUN_OOM_SCORE));
    raised = oomValue(file.read()) === RUN_OOM_SCORE;
  } catch {
    raised = false;
  }
  let restored = !raised;
  return {
    raised,
    restore: () => {
      if (restored) return true;
      try {
        file.write(String(before));
        restored = oomValue(file.read()) === before;
      } catch {
        restored = false;
      }
      return restored;
    },
  };
}

/** The words that start `argv` as the user: numeric ids, the user's other groups, and the parent-death signal so the program dies when its launcher does. */
export function setprivArgv(setpriv: string, uid: number, gid: number, argv: readonly string[]): string[] {
  return [setpriv, '--reuid', String(uid), '--regid', String(gid), '--init-groups', '--pdeathsig', 'SIGKILL', '--', ...argv];
}

/** The kinds that are a bot's run (an adapter) and get a scope of their own; the repository sync and the sign-in kinds do not. */
export const SCOPED_KINDS: readonly Kind[] = ['claude', 'codex', 'hermes'];

/**
 * The words that start `argv` in a scope of its own (P31-04): `systemd-run --scope` runs the program in place (the same pid, process group and signals; the helper's watch is
 * unchanged) after systemd has moved it into `mtruns.slice/<unit>`. `MemoryMax` is the run's limit, `MemorySwapMax=0` so it is not pushed to swap first, and `OOMPolicy=continue`
 * keeps `memory.oom.group` 0: the kernel stops the one biggest program of the run (a typecheck, a test worker), not the whole run. No `MemoryHigh` (it slows a run, never stops it).
 * Pure: the helper builds it from its own table and a checked tag, nothing else.
 */
export function scopeArgv(scope: RunScope, unit: string, argv: readonly string[]): string[] {
  if (!/^mt-run-[a-z0-9-]{1,80}\.scope$/.test(unit)) throw new Error('not a run scope unit');
  if (!Number.isSafeInteger(scope.memoryMaxBytes) || scope.memoryMaxBytes < RUN_MEMORY_MIN_BYTES || scope.memoryMaxBytes > RUN_MEMORY_MAX_BYTES) throw new Error('the run memory limit is out of range');
  return [
    scope.systemdRun,
    '--scope',
    '--quiet',
    '--collect',
    `--slice=${RUNS_SLICE}`,
    `--unit=${unit}`,
    '-p', `MemoryMax=${scope.memoryMaxBytes}`,
    '-p', 'MemorySwapMax=0',
    '-p', 'OOMPolicy=continue',
    ...(scope.bindsTo !== undefined ? ['-p', `BindsTo=${scope.bindsTo}`, '-p', `After=${scope.bindsTo}`] : []),
    '--',
    ...argv,
  ];
}

/** A tag for a run whose header names none: 16 lower case hex digits. */
export const newRunTag = (): string => randomBytes(8).toString('hex');

/**
 * Whether this run gets a scope, and its unit name: a scoped kind, a table that allows scopes, `systemd-run` present and systemd running the machine (`/run/systemd/system`, the
 * check `sd_booted` makes). Anything else: null, and the run starts as before (weighted by `oom_score_adj` only). Pure apart from `exists`.
 */
export function scopeFor(cfg: HelperConfig, kind: Kind, team: string, tag: string | undefined, exists: (path: string) => boolean): { scope: RunScope; unit: string } | null {
  const scope = cfg.runScope;
  if (scope === undefined || !SCOPED_KINDS.includes(kind)) return null;
  if (!exists(scope.systemdRun) || !exists('/run/systemd/system')) return null;
  return { scope, unit: runScopeUnit(team, tag !== undefined && isRunTag(tag) ? tag : newRunTag()) };
}

const which = (candidates: readonly string[]): string | null => candidates.find((c) => existsSync(c)) ?? null;
const sysEnv = (): NodeJS.ProcessEnv => ({ PATH: SYSTEM_PATH, LC_ALL: 'C' });

function run(cmd: string, args: string[], input?: string, timeoutMs = 60_000): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { encoding: 'utf8', env: sysEnv(), ...(input !== undefined ? { input } : {}), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 20 });
}

export interface Account {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export function lookup(name: string): Account | null {
  const r = run('getent', ['passwd', name]);
  if (r.status !== 0) return null;
  const f = r.stdout.trim().split(':');
  if (f.length < 7 || f[0] !== name) return null;
  return { name, uid: Number(f[2]), gid: Number(f[3]), home: f[5]!, shell: f[6]! };
}

const groupId = (name: string): number | null => {
  const r = run('getent', ['group', name]);
  const f = r.status === 0 ? r.stdout.trim().split(':') : [];
  return f.length >= 3 && f[0] === name ? Number(f[2]) : null;
};

/** `<root>/work` belongs to root and nobody else can write to it: a home made there cannot be redirected by a link. */
function checkWorkFolder(root: string): void {
  const work = posix.join(root, 'work');
  let st;
  try {
    st = lstatSync(work);
  } catch {
    throw new Error(`${work} is missing (run the installer again)`);
  }
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0) throw new Error(`${work} must be a folder of root that nobody else can write to`);
}

/**
 * Makes the team's user and its home when they are not there, and makes sure they are what they must be when they are. The user: a system account named `mt-team-<team>` with its own group,
 * no login shell, the home under `<root>/work`, and the group `mt-agents`. The home: the user's, mode 0700; with a publisher group, the group's and mode 2750 (the publisher reads a
 * bot's clone to publish it; nobody else of that group exists). Returns the account.
 */
export function ensureUser(cfg: HelperConfig, team: string): Account {
  const name = teamUserName(team);
  const home = teamHome(cfg.dataRoot, team);
  checkWorkFolder(cfg.dataRoot);
  if (groupId(AGENTS_GROUP) === null) throw new Error(`the group ${AGENTS_GROUP} does not exist (run the installer again)`);
  let acct = lookup(name);
  if (acct === null) {
    const shell = which(NOLOGIN_SHELLS) ?? '/bin/false';
    const made = run('useradd', ['--system', '--user-group', '--home-dir', home, '--no-create-home', '--shell', shell, '--groups', AGENTS_GROUP, '--comment', `manythreads team ${team}`, name]);
    // two runs of a new team at once: the second useradd loses; the user is there now
    acct = lookup(name);
    if (acct === null) throw new Error(`could not make the user ${name}: ${(made.stderr || made.stdout || 'useradd failed').trim().slice(0, 200)}`);
  }
  if (acct.uid === 0 || acct.gid === 0) throw new Error(`${name} must not be root`);
  if (acct.home !== home) throw new Error(`${name} exists with another home (${acct.home}); it is not touched`);
  if (!NOLOGIN_SHELLS.includes(acct.shell) && acct.shell !== '/bin/false') throw new Error(`${name} has a login shell; it is not touched`);
  const groups = run('id', ['-nG', name]);
  if (!groups.stdout.split(/\s+/).includes(AGENTS_GROUP)) run('usermod', ['-a', '-G', AGENTS_GROUP, name]);
  // the publisher's socket is open to this group only: a team user outside it cannot even reach the folder, so no bot of the team could publish (P26-19 proof 4)
  if (cfg.publishClientsGroup !== undefined && groupId(cfg.publishClientsGroup) !== null && !groups.stdout.split(/\s+/).includes(cfg.publishClientsGroup)) run('usermod', ['-a', '-G', cfg.publishClientsGroup, name]);

  const pubGid = cfg.publisherGroup === undefined ? null : groupId(cfg.publisherGroup);
  const gid = pubGid ?? acct.gid;
  const mode = pubGid !== null ? 0o2750 : 0o700;
  let st;
  try {
    st = lstatSync(home);
  } catch {
    st = null;
  }
  if (st === null) mkdirSync(home, { mode: 0o700 });
  else if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== acct.uid) throw new Error(`${home} is not the folder of ${name}; it is not touched`);
  // by an open descriptor of the folder itself, not by its name
  const fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const now = fstatSync(fd);
    if (now.uid !== acct.uid && st !== null) throw new Error(`${home} changed owner under the helper`);
    fchownSync(fd, acct.uid, gid);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
  return acct;
}

/** How deep and how many: the sign-in folders hold a few dozen files, session transcripts included; a folder far beyond that is not one of ours and is left alone. */
const AUTH_MAX_DEPTH = 8;
const AUTH_MAX_ENTRIES = 50_000;

/** The sign-in folders the helper keeps open to the group `mt-agents`: Claude's only. Codex's is the bridge user's alone since P31-01 (each team has a copy in its own Codex home). */
export const SHARED_AUTH_FOLDERS: readonly string[] = ['claude'];

/**
 * Claude's sign-in folder is shared by the teams' users through the group `mt-agents`. A CLI that makes a file with mode 0600 (its own choice) would lock the other teams out of it, so every
 * file and folder below it gets the group and the group's bits back (folders keep the setgid bit, so what they make there stays the group's). Run as root over folders that
 * the teams' users can write, so no step follows a link: a folder is opened with O_NOFOLLOW and its children are reached through `/proc/self/fd/<that folder>/<name>` (never through a path
 * that a team user could swap for a link between two steps), a file is opened with O_NOFOLLOW and changed through its descriptor, and a file with more than one name is not touched.
 */
export function fixAuthFolders(root: string): number {
  const gid = groupId(AGENTS_GROUP);
  if (gid === null) return 0;
  const budget = { left: AUTH_MAX_ENTRIES, fixed: 0 };
  const visit = (fd: number, st: Stats): void => {
    const want = st.isDirectory() ? 0o2770 : 0o660;
    if (st.gid !== gid) fchownSync(fd, st.uid, gid);
    if (((st.mode & 0o7777) & want) !== want) fchmodSync(fd, (st.mode & 0o7777) | want);
    if (st.gid !== gid || ((st.mode & 0o7777) & want) !== want) budget.fixed += 1;
  };
  const walk = (dirFd: number, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(`/proc/self/fd/${dirFd}`);
    } catch {
      return;
    }
    for (const n of names) {
      if (budget.left-- <= 0) return;
      let fd: number | null = null;
      try {
        fd = openSync(`/proc/self/fd/${dirFd}/${n}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const st = fstatSync(fd);
        if (st.isDirectory()) {
          if (depth < AUTH_MAX_DEPTH) {
            visit(fd, st);
            walk(fd, depth + 1);
          }
        } else if (st.isFile() && st.nlink === 1) {
          visit(fd, st);
        }
      } catch {
        // gone, or a link (O_NOFOLLOW), or not ours to open: left alone
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
  };
  for (const agent of SHARED_AUTH_FOLDERS) {
    let fd: number | null = null;
    try {
      fd = openSync(posix.join(root, 'auth', agent), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      const st = fstatSync(fd);
      visit(fd, st);
      walk(fd, 1);
    } catch {
      continue;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return budget.fixed;
}

/** One line from file descriptor 0, read a byte at a time so nothing after it is taken from the program that follows. */
export function readFirstLine(fd = 0, limit = MAX_HEADER_BYTES): string {
  const chunks: Buffer[] = [];
  const one = Buffer.alloc(1);
  let size = 0;
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, one, 0, 1, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      if ((err as NodeJS.ErrnoException).code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    if (one[0] === 0x0a) break;
    size += 1;
    if (size > limit) throw new Error('the header is too long');
    chunks.push(Buffer.from(one));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface Plan {
  acct: Account;
  setpriv: string;
}

const asUser = (plan: Plan, argv: readonly string[], input?: string): SpawnSyncReturns<string> => {
  const [cmd, ...args] = setprivArgv(plan.setpriv, plan.acct.uid, plan.acct.gid, argv);
  return run(cmd!, args, input);
};

/**
 * The team's own sign-in folders a header names (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` set to `.signin/<agent>`; `parseHeader` allowed nothing else there), each to be made like the Codex home:
 * by the team user, 0700, no setgid bit (a team home may be 2750). The bridge never makes a folder inside a team home.
 */
export function signinFoldersOf(header: LaunchHeader, root: string, team: string): string[] {
  const own = [teamSigninDir(root, team, 'claude'), teamSigninDir(root, team, 'codex')];
  const named = [header.env['CLAUDE_CONFIG_DIR'], header.env['CODEX_HOME']].filter((v): v is string => v !== undefined && own.includes(v));
  return named.length === 0 ? [] : [teamSigninRoot(root, team), ...named];
}

/**
 * Whether a team's own sign-in folder may be acted on by root's helper: `<home>/.signin` is a real folder of the team user (not a link), and the named folder is directly in it and is
 * not a link either (a missing one is fine: there is nothing to remove). Root only looks (`lstat`, no link followed); every change is made as the team user.
 */
export function ownSigninFolderOk(root: string, team: string, folder: string, uid: number): boolean {
  const signin = teamSigninRoot(root, team);
  if (posix.dirname(folder) !== signin || (folder !== teamSigninDir(root, team, 'claude') && folder !== teamSigninDir(root, team, 'codex'))) return false;
  let top: Stats;
  try {
    top = lstatSync(signin);
  } catch {
    return true;
  }
  if (top.isSymbolicLink() || !top.isDirectory() || top.uid !== uid) return false;
  try {
    const st = lstatSync(folder);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return true;
  }
}

/** What `signin-facts` prints about a team's own sign-in file: its shape and its dates, never a token (the bridge's gate holds one renewing run of the team near a renewal). */
export interface SigninFactsLine {
  exists: boolean;
  valid: boolean;
  expiresAt: number | null;
  refreshedAt: number | null;
  mtimeMs: number | null;
}

/** The facts of a sign-in file's text: Claude's `.credentials.json` (its access token's expiry and scope) or Codex's `auth.json` (`codex-token.ts`). No token leaves this function. */
export function signinFactsOf(agent: 'claude' | 'codex', text: string | null, mtimeMs: number | null): SigninFactsLine {
  if (text === null) return { exists: false, valid: false, expiresAt: null, refreshedAt: null, mtimeMs: null };
  if (agent === 'codex') {
    const f = codexTokenFacts(text);
    return { exists: true, valid: f?.chatgpt === true, expiresAt: f?.chatgpt === true ? f.accessExpiresAt : null, refreshedAt: f?.lastRefresh ?? null, mtimeMs };
  }
  try {
    const oauth = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown; scopes?: unknown } }).claudeAiOauth;
    const valid = typeof oauth === 'object' && oauth !== null && typeof oauth.accessToken === 'string' && Array.isArray(oauth.scopes) && oauth.scopes.includes('user:inference');
    return { exists: true, valid, expiresAt: valid && typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null, refreshedAt: null, mtimeMs };
  } catch {
    return { exists: true, valid: false, expiresAt: null, refreshedAt: null, mtimeMs };
  }
}

/** Files, the working folder and the temporary folder: all made by the team's user. */
function prepare(plan: Plan, header: LaunchHeader, home: string, signin: readonly string[] = []): void {
  const dirs = asUser(plan, ['/bin/sh', '-c', SH_MKDIR, 'sh', '0077', posix.join(home, 'tmp')]);
  if (dirs.status !== 0) throw new Error('could not make the temporary folder');
  for (const d of signin) if (asUser(plan, ['/bin/sh', '-c', SH_PRIVATE_DIR, 'sh', d]).status !== 0) throw new Error('could not make the team\'s own sign-in folder');
  const cwd = asUser(plan, ['/bin/sh', '-c', SH_MKDIR, 'sh', '0027', header.cwd]);
  if (cwd.status !== 0) throw new Error('could not make the working folder');
  for (const f of header.files) {
    const put = asUser(plan, ['/bin/sh', '-c', SH_PUT, 'sh', f.path, f.mode], f.text);
    if (put.status !== 0) throw new Error('could not write a file the run needs');
  }
}

function remove(plan: Plan, paths: readonly string[]): void {
  if (paths.length === 0) return;
  asUser(plan, ['/bin/sh', '-c', SH_RM, 'sh', ...paths]);
}

// ---- the team's copy of the Codex sign-in (P31-01, docs/plans/codex-teams-and-oom.md section 2 and its corrections) ------------------------------------------------------------

/** A read of the main copy: its text, `missing` (no file: a sign-out), or `failed` (it timed out, could not be started, or was not readable): then nothing is decided and the next look tries again. */
export type MainRead = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'failed' };

/** What the copy steps do to the two files, each as the file's owner. A team read answers the file's text, or null (missing, unreadable, too big, or the read timed out). */
export interface CodexCopyIo {
  readMain(): MainRead;
  readTeam(): string | null;
  writeMain(text: string): boolean;
  writeTeam(text: string): boolean;
  removeTeam(): void;
  log(line: string): void;
}

/** The state of one run's copy: what the team's copy holds as far as the helper knows (null: nothing was copied in, or it was taken away), and the refusals already logged. */
export interface CodexCopyState {
  base: CodexTokenFacts | null;
  refused: Set<string>;
}

/** What is to be done to the team's copy after the lock of the main copy is let go (review fix: nothing a team controls is touched while every team waits on that lock). */
export type TeamAction = { kind: 'none' } | { kind: 'write'; text: string; base: CodexTokenFacts | null } | { kind: 'remove' };

const factsOf = (text: string | null): CodexTokenFacts | null => (text === null ? null : codexTokenFacts(text));

/** Under the main copy's lock, before the program starts: the machine's sign-in is to be copied in when it is a ChatGPT sign-in; otherwise none is, and Codex says it is not signed in. */
export function codexCopyInLocked(state: CodexCopyState, io: CodexCopyIo): TeamAction {
  const read = io.readMain();
  const facts = read.kind === 'ok' ? factsOf(read.text) : null;
  if (read.kind !== 'ok' || accountOf(facts) === null) {
    io.log(read.kind === 'failed' ? 'the machine\'s Codex sign-in could not be read; the run starts without one' : 'this machine has no Codex sign-in to copy; the run starts without one');
    state.base = null;
    return { kind: 'remove' };
  }
  return { kind: 'write', text: read.text, base: facts };
}

/**
 * Under the main copy's lock, every 15 seconds while the run lasts and once at its end, with the team's copy as it was read just before (outside the lock). Cases:
 *   - the main copy is gone (a sign-out) or names another account (a new sign-in): the team's copy is to be removed and nothing is ever copied back. A main copy that could not be
 *     read (a timeout, a failed start) or is not readable as a sign-in decides nothing: the next look tries again;
 *   - the team's copy changed (its Codex renewed the tokens): when `acceptRenewed` says so, a file rebuilt from the known fields (`rebuildRenewed`) replaces the main copy and the team's
 *     copy; else one log line, and the copy is left alone (a refused copy goes nowhere);
 *   - the main copy was renewed by another team's run: it is to be copied into this team's copy, because Codex reads `auth.json` again before it renews (review correction 2, measured);
 *   - nothing changed: nothing is done.
 */
export function codexSyncLocked(state: CodexCopyState, io: CodexCopyIo, teamText: string | null, now: number = Date.now()): TeamAction {
  const base = state.base;
  if (base === null) return { kind: 'none' };
  const read = io.readMain();
  if (read.kind === 'failed') return { kind: 'none' };
  const main = read.kind === 'ok' ? factsOf(read.text) : null;
  if (read.kind === 'ok' && main === null) return { kind: 'none' };
  if (read.kind === 'missing' || accountOf(main) !== accountOf(base)) {
    state.base = null;
    io.log('the machine\'s Codex sign-in was removed or changed, so this run\'s copy was removed');
    return { kind: 'remove' };
  }
  const mainText = read.text;
  const team = factsOf(teamText);
  // another run of the same team (they share the team's copy) already copied this one back
  if (team !== null && main !== null && team.sha256 === main.sha256) {
    state.base = team;
    return { kind: 'none' };
  }
  if (team !== null && team.sha256 === base.sha256) return mainIsNewer(main, base, now) ? { kind: 'write', text: mainText, base: main } : { kind: 'none' };
  const verdict = acceptRenewed(main, base, team, now);
  if (verdict.ok && teamText !== null) {
    const rebuilt = rebuildRenewed(teamText, mainText);
    if (rebuilt !== null && io.writeMain(rebuilt)) {
      state.base = factsOf(rebuilt);
      return { kind: 'write', text: rebuilt, base: state.base };
    }
    io.log('a renewed Codex sign-in could not be copied back to the machine\'s main copy');
    return { kind: 'none' };
  }
  const reason = verdict.ok ? 'not_a_login' : verdict.reason;
  const key = `${reason}:${team?.sha256 ?? 'none'}`;
  if (!state.refused.has(key)) {
    state.refused.add(key);
    io.log(refusalLine(reason));
  }
  // two runs renewed at once: the main copy (written first) wins, and this run is given it, so its next renewal starts from a token that is still good
  if (reason === 'main_changed' && mainIsNewer(main, team ?? base, now)) return { kind: 'write', text: mainText, base: main };
  return { kind: 'none' };
}

/** Outside the main copy's lock (under the team's own lock in the helper): what the locked step decided for the team's copy. */
export function applyTeamAction(state: CodexCopyState, io: CodexCopyIo, action: TeamAction): void {
  if (action.kind === 'remove') io.removeTeam();
  else if (action.kind === 'write') {
    if (io.writeTeam(action.text)) state.base = action.base;
    else io.log('the Codex sign-in could not be copied into the team\'s Codex home');
  }
}

/** The three steps of one look in one call (no lock): what the tests drive. */
export function codexSync(state: CodexCopyState, io: CodexCopyIo, now: number = Date.now()): void {
  const teamText = state.base === null ? null : io.readTeam();
  applyTeamAction(state, io, codexSyncLocked(state, io, teamText, now));
}

/** The copy-in in one call (no lock): what the tests drive. */
export function codexCopyIn(io: CodexCopyIo): CodexCopyState {
  const state: CodexCopyState = { base: null, refused: new Set() };
  applyTeamAction(state, io, codexCopyInLocked(state, io));
  return state;
}

/** The folder of root's own files for the Codex copies: `<root>/auth/.locks`, made 0700 under `<root>/auth`, which must be root's and writable by nobody else. */
export function codexLockFolder(root: string): string {
  const auth = posix.join(root, 'auth');
  const st = lstatSync(auth);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0) throw new Error(`${auth} must be a folder of root that nobody else can write to`);
  const locks = posix.join(auth, '.locks');
  for (const dir of [locks, posix.join(locks, 'codex-live'), posix.join(locks, 'codex-moved')]) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const d = lstatSync(dir);
    if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== 0 || (d.mode & 0o077) !== 0) throw new Error(`${dir} must be a folder of root's alone`);
  }
  return locks;
}

/** The kernel's start time of a process (field 22 of /proc/<pid>/stat), so a marker is not taken for alive when its pid was given to another process. */
export function procStartTime(pid: number, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  try {
    const stat = read(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** The live markers of a team's Codex runs: `<locks>/codex-live/<team>/<pid>.<start time>`, made by root. */
export class CodexMarkers {
  readonly folder: string;
  constructor(locks: string, team: string) {
    this.folder = posix.join(locks, 'codex-live', team);
  }

  /** This helper's marker; returns its path. */
  add(pid = process.pid): string {
    try {
      mkdirSync(this.folder, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const path = posix.join(this.folder, `${pid}.${procStartTime(pid) ?? '0'}`);
    writeFileSync(path, '', { mode: 0o600, flag: 'w' });
    return path;
  }

  /** Removes the markers of helpers that are gone; answers how many are alive besides `own`. */
  othersAlive(own: string | null): number {
    let names: string[];
    try {
      names = readdirSync(this.folder);
    } catch {
      return 0;
    }
    let alive = 0;
    for (const n of names) {
      const path = posix.join(this.folder, n);
      if (path === own) continue;
      const m = /^(\d{1,10})\.(\d{1,20})$/.exec(n);
      if (m !== null && procStartTime(Number(m[1])) === m[2]) alive += 1;
      else rmSync(path, { force: true });
    }
    return alive;
  }

  remove(own: string): void {
    rmSync(own, { force: true });
  }
}

/**
 * Holds `<locks>/<name>` with `flock(1)` for as long as `fn` runs (review correction 4: no pid file, so no pid reuse and no "stale after 10 seconds"). A holder process keeps the lock
 * while its standard input is open, so the lock goes when the helper dies whatever way. Answers false when the lock was not had within `waitSeconds` (nothing was done then).
 * Two locks: `codex-token.lock`, shared by every team, held only while the main copy is read, compared and written; and `codex-team-<team>.lock`, one team's, held while that team's
 * own files (its copy, its markers, its old Codex home) are changed, so a slow or hostile team folder never makes another team wait.
 */
export async function withCodexLock(flock: string, locks: string, fn: () => void, waitSeconds = 20, name = 'codex-token.lock'): Promise<boolean> {
  const holder = spawn(flock, ['-w', String(waitSeconds), posix.join(locks, name), '/bin/sh', '-c', 'echo locked; exec cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'], env: sysEnv() });
  const ended = new Promise<void>((resolve) => {
    holder.on('close', () => resolve());
    holder.on('error', () => resolve());
  });
  const locked = await new Promise<boolean>((resolve) => {
    let seen = '';
    holder.stdout?.on('data', (b: Buffer) => {
      seen += b.toString('utf8');
      if (seen.includes('locked')) resolve(true);
    });
    void ended.then(() => resolve(false));
  });
  try {
    if (locked) fn();
  } finally {
    holder.stdin?.end();
    await ended;
  }
  return locked;
}

/** The name of one team's own lock in the lock folder. */
export const teamLockName = (team: string): string => `codex-team-${team}.lock`;

/** The copy steps as the two owners: the main copy as the bridge user, the team's copy as the team user, each through a constant `sh` snippet. */
export function codexIo(setpriv: string, bridge: Account, team: Account, root: string, teamName: string, log: (line: string) => void): CodexCopyIo {
  const as = (who: Account, argv: string[], input?: string, timeoutMs = 10_000): SpawnSyncReturns<string> => {
    const [cmd, ...args] = setprivArgv(setpriv, who.uid, who.gid, argv);
    return run(cmd!, args, input, timeoutMs);
  };
  const mainFile = posix.join(root, 'auth', 'codex', 'auth.json');
  const teamFile = posix.join(teamCodexHome(root, teamName), 'auth.json');
  const read = (who: Account, file: string): MainRead => {
    const r = as(who, ['/bin/sh', '-c', SH_READ, 'sh', file], undefined, 5_000);
    if (r.status === SH_READ_MISSING) return { kind: 'missing' };
    if (r.status !== 0 || typeof r.stdout !== 'string' || r.stdout === '' || Buffer.byteLength(r.stdout) > CODEX_AUTH_MAX_BYTES) return { kind: 'failed' };
    return { kind: 'ok', text: r.stdout };
  };
  return {
    readMain: () => read(bridge, mainFile),
    readTeam: () => {
      const r = read(team, teamFile);
      return r.kind === 'ok' ? r.text : null;
    },
    writeMain: (text) => as(bridge, ['/bin/sh', '-c', SH_REPLACE, 'sh', mainFile], text).status === 0,
    writeTeam: (text) => as(team, ['/bin/sh', '-c', SH_PUT, 'sh', teamFile, '0600'], text).status === 0,
    removeTeam: () => void as(team, ['/bin/sh', '-c', SH_RM, 'sh', teamFile]),
    log,
  };
}

/**
 * The team's Codex home, made by the team user with mode 0700. Once per team (a marker in root's lock folder), a Codex home made before P31-01 is removed first: one was made by a run
 * that had no CODEX_HOME (2026-11-17, mode 2755, files 0644, readable by the publisher's group). Only once, because from then on that folder is the team's real Codex home.
 */
export function prepareCodexHome(plan: Plan, locks: string, root: string, team: string): void {
  removeOldCodexHomeOnce(plan, locks, root, team);
  if (asUser(plan, ['/bin/sh', '-c', SH_PRIVATE_DIR, 'sh', teamCodexHome(root, team)]).status !== 0) throw new Error('could not make the team\'s Codex home');
}

/** The once-per-team removal of a Codex home made before P31-01 (see `prepareCodexHome`). */
export function removeOldCodexHomeOnce(plan: Plan, locks: string, root: string, team: string): void {
  const moved = posix.join(locks, 'codex-moved', team);
  if (existsSync(moved)) return;
  if (asUser(plan, ['/bin/sh', '-c', SH_RM, 'sh', teamCodexHome(root, team)]).status !== 0) throw new Error('could not remove the team\'s old Codex home');
  writeFileSync(moved, '', { mode: 0o600 });
}

const FLOCK = ['/usr/bin/flock', '/bin/flock'];

/** One Codex run's copy, as the helper's main function keeps it. */
interface CodexRun {
  io: CodexCopyIo;
  state: CodexCopyState;
  markers: CodexMarkers;
  marker: string | null;
  locks: string;
  flock: string;
  team: string;
}

const tokenLocked = (c: CodexRun, fn: () => void): Promise<boolean> => withCodexLock(c.flock, c.locks, fn);
const teamLocked = (c: CodexRun, fn: () => void): Promise<boolean> => withCodexLock(c.flock, c.locks, fn, 20, teamLockName(c.team));

/** One look while the run lasts: the team's copy is read with no lock, the main copy is compared and written under the shared lock, the team's copy is changed under the team's lock. */
async function codexLook(c: CodexRun): Promise<void> {
  if (c.state.base === null) return;
  const teamText = c.io.readTeam();
  const box: { action: TeamAction } = { action: { kind: 'none' } };
  if (!(await tokenLocked(c, () => (box.action = codexSyncLocked(c.state, c.io, teamText))))) return;
  if (box.action.kind !== 'none') await teamLocked(c, () => applyTeamAction(c.state, c.io, box.action));
}

const say = (line: string): void => void process.stderr.write(`mt-team-helper: ${line}\n`);

/** The entry: returns the exit code. `argv` is what follows the program's own name. */
export async function main(argv: readonly string[]): Promise<number> {
  if (process.geteuid?.() !== 0) {
    say('this program is run through sudo by the bridge');
    return 64;
  }
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    say(parsed.error);
    return 64;
  }
  let cfg: HelperConfig;
  try {
    const st = statSync(CONFIG_FILE);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) throw new Error(`${CONFIG_FILE} must belong to root and not be writable by others`);
    cfg = parseHelperConfig(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    say(err instanceof Error ? err.message : 'the helper table cannot be read');
    return 70;
  }
  let acct: Account;
  try {
    acct = ensureUser(cfg, parsed.team);
  } catch (err) {
    say(err instanceof Error ? err.message : 'could not make the team user');
    return 71;
  }
  if (parsed.command === 'ensure-user') {
    process.stdout.write(`ok ${acct.name}\n`);
    return 0;
  }
  const home = teamHome(cfg.dataRoot, parsed.team);
  const setpriv = which(['/usr/bin/setpriv', '/bin/setpriv', '/usr/sbin/setpriv']);
  if (setpriv === null) {
    say('setpriv is needed (the util-linux package)');
    return 72;
  }
  const plan: Plan = { acct, setpriv };
  let header: LaunchHeader;
  try {
    const parsedHeader = parseHeader(readFirstLine(), { root: cfg.dataRoot, team: parsed.team, kind: parsed.kind });
    if (!parsedHeader.ok) {
      say(parsedHeader.error);
      return 65;
    }
    header = parsedHeader.header;
    if (parsedHeader.dropped.length > 0) say(`left out of the environment: ${parsedHeader.dropped.slice(0, 10).join(', ')}`);
  } catch (err) {
    say(err instanceof Error ? err.message : 'the header cannot be read');
    return 65;
  }
  if (parsed.kind === 'clean-kube') {
    remove(plan, [posix.join(home, 'kube')]);
    return 0;
  }
  if (parsed.kind === 'clean-signin' || parsed.kind === 'signin-facts') {
    // the one own folder the header names (parseHeader allowed only the team's own); refused when `.signin` or the folder is a link, or `.signin` is not the team user's
    const folder = (header.env['CLAUDE_CONFIG_DIR'] ?? header.env['CODEX_HOME']) as string;
    if (!ownSigninFolderOk(cfg.dataRoot, parsed.team, folder, acct.uid)) {
      say('the team\'s own sign-in folder is not a plain folder of the team user; it is not touched');
      return 73;
    }
    if (parsed.kind === 'signin-facts') {
      const agent = header.env['CODEX_HOME'] !== undefined ? 'codex' : 'claude';
      const file = posix.join(folder, agent === 'codex' ? 'auth.json' : '.credentials.json');
      // read as the team user, bounded (SH_READ); root only looks at the file's time (lstat, no link followed)
      const r = asUser(plan, ['/bin/sh', '-c', SH_READ, 'sh', file]);
      const text = r.status === 0 && typeof r.stdout === 'string' && r.stdout !== '' && Buffer.byteLength(r.stdout) <= CODEX_AUTH_MAX_BYTES ? r.stdout : null;
      let mtimeMs: number | null = null;
      try {
        const st = lstatSync(file);
        if (st.isFile()) mtimeMs = st.mtimeMs;
      } catch {
        mtimeMs = null;
      }
      if (text === null && r.status !== SH_READ_MISSING) {
        say('the team\'s own sign-in file could not be read');
        return 73;
      }
      process.stdout.write(`${JSON.stringify(signinFactsOf(agent, text, mtimeMs))}\n`);
      return 0;
    }
    if (asUser(plan, ['/bin/sh', '-c', SH_RM, 'sh', folder]).status !== 0) {
      say('could not remove the team\'s own sign-in');
      return 73;
    }
    asUser(plan, ['/bin/sh', '-c', SH_RMDIR, 'sh', teamSigninRoot(cfg.dataRoot, parsed.team)]);
    return 0;
  }
  const flock = which(FLOCK);
  if (parsed.kind === 'clean-codex') {
    // the team's copy of the Codex sign-in goes (its sessions and state stay); the markers of runs that are gone go with it. Only the team's own lock: nothing here is another team's.
    try {
      const locks = codexLockFolder(cfg.dataRoot);
      const clean = (): void => {
        removeOldCodexHomeOnce(plan, locks, cfg.dataRoot, parsed.team);
        new CodexMarkers(locks, parsed.team).othersAlive(null);
        remove(plan, [posix.join(teamCodexHome(cfg.dataRoot, parsed.team), 'auth.json')]);
      };
      if (flock === null || !(await withCodexLock(flock, locks, clean, 20, teamLockName(parsed.team)))) clean();
    } catch (err) {
      say(err instanceof Error ? err.message : 'could not remove the team\'s Codex sign-in');
      return 73;
    }
    return 0;
  }
  let program;
  try {
    program = programFor(cfg, parsed.kind, which(SCRIPT_PATHS));
    if (program === null) return 0;
    fixAuthFolders(cfg.dataRoot);
    prepare(plan, header, home, signinFoldersOf(header, cfg.dataRoot, parsed.team));
  } catch (err) {
    say(err instanceof Error ? err.message : 'could not prepare the run');
    return 73;
  }
  // A Codex run: its own Codex home, and in it a copy of the machine's sign-in for as long as the run lasts (P31-01). The shared lock (`codex-token.lock`) is held only around the
  // main copy; everything in the team's own folder is done under the team's own lock, before or after it.
  let codex: CodexRun | null = null;
  // a team that signs in on its own (CODEX_HOME is its `.signin/codex`) has its own `auth.json` there: nothing is copied in, back or removed (P35-10b)
  if (parsed.kind === 'codex' && header.env['CODEX_HOME'] !== teamSigninDir(cfg.dataRoot, parsed.team, 'codex')) {
    try {
      if (cfg.bridgeUser === undefined) throw new Error('the helper table names no bridgeUser (run the installer again with --update)');
      if (flock === null) throw new Error('flock is needed (the util-linux package)');
      const bridgeAcct = lookup(cfg.bridgeUser);
      if (bridgeAcct === null || bridgeAcct.uid === 0) throw new Error(`the bridge user ${cfg.bridgeUser} does not exist`);
      const locks = codexLockFolder(cfg.dataRoot);
      const c: CodexRun = { io: codexIo(setpriv, bridgeAcct, acct, cfg.dataRoot, parsed.team, say), state: { base: null, refused: new Set() }, markers: new CodexMarkers(locks, parsed.team), marker: null, locks, flock, team: parsed.team };
      if (!(await teamLocked(c, () => {
        prepareCodexHome(plan, locks, cfg.dataRoot, parsed.team);
        c.marker = c.markers.add();
      }))) throw new Error('the team\'s Codex home stayed locked by another of its runs for 20 seconds');
      const box: { action: TeamAction } = { action: { kind: 'none' } };
      if (!(await tokenLocked(c, () => (box.action = codexCopyInLocked(c.state, c.io))))) throw new Error('the Codex sign-in stayed locked by another run for 20 seconds');
      if (!(await teamLocked(c, () => applyTeamAction(c.state, c.io, box.action)))) say('the team\'s Codex home stayed locked; the run starts without a copy of the sign-in');
      codex = c;
    } catch (err) {
      say(err instanceof Error ? err.message : 'could not prepare the Codex sign-in');
      remove(plan, header.removeAtEnd);
      return 73;
    }
  }
  const shell = which(['/bin/bash', '/bin/sh']) ?? '/bin/sh';
  const env = launchEnv(header, acct.name, home, shell);
  const asTeam = setprivArgv(plan.setpriv, acct.uid, acct.gid, ['/bin/sh', '-c', SH_EXEC, 'sh', program.umask, header.cwd, ...program.argv]);
  // P31-04: a bot's run in a scope of its own with its own memory limit, when this machine allows it and a first empty scope of the same kind starts (a machine whose systemd refuses
  // one of the settings runs as before, weighted by oom_score_adj only)
  let scoped = scopeFor(cfg, parsed.kind, parsed.team, header.runTag, existsSync);
  if (scoped !== null) {
    const probe = run(scoped.scope.systemdRun, scopeArgv(scoped.scope, scoped.unit.replace(/\.scope$/, '-probe.scope'), ['/bin/true']).slice(1), undefined, 15_000);
    if (probe.status !== 0) {
      say('this machine could not start a run scope; the run starts without its own memory limit');
      scoped = null;
    }
  }
  const [launcher, ...launcherArgs] = scoped !== null ? scopeArgv(scoped.scope, scoped.unit, asTeam) : asTeam;
  // the program and all it starts go first when the machine runs out of memory; the helper keeps its own value (raised just for the spawn, put back right after it)
  const oom = raiseForChild();
  if (!oom.raised) say('could not raise the run\'s out-of-memory score; it runs with the helper\'s');
  let child;
  try {
    child = spawn(launcher!, launcherArgs, { env, stdio: 'inherit', detached: true });
  } finally {
    if (!oom.restore()) say('could not put the helper\'s own out-of-memory score back');
  }
  const pid = child.pid;
  if (pid === undefined) {
    say('the program could not be started');
    remove(plan, header.removeAtEnd);
    return 74;
  }
  const kill = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      /* already gone */
    }
  };
  // sudo hands on the signals the bridge sends it; the program's whole group gets them
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) process.on(sig, () => {
    kill(sig);
    setTimeout(() => kill('SIGKILL'), 8000).unref();
  });
  // sudo killed with SIGKILL cannot hand a signal on: this program's parent changes, and the run ends
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (process.ppid !== parent) {
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 3000).unref();
    }
  }, 1000);
  // a CLI may remake a sign-in file with mode 0600 while it renews a token: give the group its bits back
  const fixer = setInterval(() => fixAuthFolders(cfg.dataRoot), 15_000);
  // Codex: a renewed copy goes back to the main copy, a main copy renewed by another run comes in, a removed main copy takes this one with it (every 15 seconds, one at a time)
  let codexBusy: Promise<unknown> | null = null;
  const codexWatch = codex === null ? null : setInterval(() => {
    const c = codex;
    if (c === null || codexBusy !== null) return;
    codexBusy = codexLook(c).catch(() => false).finally(() => {
      codexBusy = null;
    });
  }, 15_000);
  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(74));
    child.on('exit', (c, sig) => resolve(c ?? (sig === null ? 1 : 128 + (({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1, SIGQUIT: 3 } as Record<string, number>)[sig] ?? 0))));
  });
  clearInterval(watch);
  clearInterval(fixer);
  if (codexWatch !== null) clearInterval(codexWatch);
  // whatever the program left running in its group goes with it (before the last look at the Codex copy: nothing of the run can write it after that)
  kill('SIGKILL');
  // and whatever left the group but stayed in the run's scope (a program that started its own session): the scope is stopped, which ends everything in it
  if (scoped !== null) run('systemctl', ['stop', '--no-block', '--', scoped.unit], undefined, 15_000);
  fixAuthFolders(cfg.dataRoot);
  if (codex !== null) {
    const c = codex;
    await codexBusy;
    try {
      const teamText = c.state.base === null ? null : c.io.readTeam();
      const box: { action: TeamAction } = { action: { kind: 'none' } };
      if (!(await tokenLocked(c, () => (box.action = codexSyncLocked(c.state, c.io, teamText))))) say('the Codex sign-in stayed locked at the end of the run; a renewal of this run was not copied back');
      const ended = await teamLocked(c, () => {
        if (c.marker !== null) c.markers.remove(c.marker);
        // the team's copy goes unless another Codex run of the same team still uses it
        if (c.markers.othersAlive(c.marker) === 0) c.io.removeTeam();
        else applyTeamAction(c.state, c.io, box.action);
      });
      if (!ended) {
        if (c.marker !== null) c.markers.remove(c.marker);
        say('the team\'s Codex home stayed locked at the end of the run; its copy is removed when the bridge starts again');
      }
    } catch {
      say('could not finish with the team\'s Codex sign-in');
    }
  }
  remove(plan, header.removeAtEnd);
  return code;
}
