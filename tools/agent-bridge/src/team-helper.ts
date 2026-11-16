import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, constants, type Stats, existsSync, fchmodSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { AGENTS_GROUP, isKind, isSlug, launchEnv, MAX_HEADER_BYTES, parseHeader, teamHome, teamUserName, type Kind, type LaunchHeader } from './team-user.ts';

// The root helper of an enrolled server (PLAN P26-22, docs/plans/agents-anywhere.md section 9b). The installer puts a copy at /opt/manythreads-bridge/helper/ (root's, 0755) and a sudoers
// rule that lets the bridge's user run exactly two commands of it:
//
//   mt-team-helper ensure-user <team>        make the team's user `mt-team-<team>` and its home (idempotent)
//   mt-team-helper run <team> <kind>         start one fixed program as that user: <kind> is claude, codex, hermes (the adapters), sync (the repository sync) or clean-kube
//
// Everything the sudoers rule cannot say (it only matches words) is checked here: the slug, the kind, that there are no more arguments. The programs come from a table the installer
// wrote as root (`/etc/manythreads-bridge/team-agents.json`): the bridge names a kind, never a program. The run's environment, the files it needs and the working folder come on the
// FIRST LINE OF STANDARD INPUT as JSON (never in an argument: a command line is readable by every user on the machine), are checked by `parseHeader`, and the rest of standard input
// is handed on to the program untouched: the adapter's own protocol. The run token is therefore in the program's environment only.
//
// Rules this file keeps, because it runs as root over folders that a team user can write into:
//   - what is made or changed as root lies in folders that no team user can write: `<root>/work` (root's, checked) and the new home right after it is made. Everything a team's own files
//     need (its work folder, the kube folder, a file) is made by a program started AS that user (`setpriv`), so a link planted in a home cannot make root write somewhere else;
//   - the sign-in folders are shared on purpose (group `mt-agents`); the only thing done there as root is fixing the group and the group bits of the files directly in them, on an open
//     file descriptor that is not a link and has one name (`O_NOFOLLOW`, `nlink` 1), so a link or a hard link planted there is left alone.

export const CONFIG_FILE = '/etc/manythreads-bridge/team-agents.json';
export const NOLOGIN_SHELLS = ['/usr/sbin/nologin', '/sbin/nologin', '/usr/bin/nologin', '/bin/false'];
const SYSTEM_PATH = '/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface AgentProgram {
  command: string;
  args: string[];
}

export interface HelperConfig {
  /** The bridge's data folder (`server.root`). */
  dataRoot: string;
  agents: Partial<Record<'claude' | 'codex' | 'hermes', AgentProgram>>;
  /** The pod's `repo-sync.sh` (from the release's tools folder), run with `sh`. */
  syncScript?: string | undefined;
  /** The group of the publisher service; the team home belongs to it (mode 2750) so the publisher can read a bot's clone. Absent: the home is 0700. */
  publisherGroup?: string | undefined;
}

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
    agents[k] = { command: v['command'], args: (v['args'] as string[] | undefined) ?? [] };
  }
  const sync = raw['syncScript'];
  if (sync !== undefined && !absolute(sync)) throw new Error('syncScript must be an absolute path');
  const pub = raw['publisherGroup'];
  if (pub !== undefined && (typeof pub !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(pub))) throw new Error('publisherGroup must be a group name');
  return { dataRoot: raw['dataRoot'], agents, ...(typeof sync === 'string' ? { syncScript: sync } : {}), ...(typeof pub === 'string' ? { publisherGroup: pub } : {}) };
}

export type Parsed = { ok: true; command: 'ensure-user'; team: string } | { ok: true; command: 'run'; team: string; kind: Kind } | { ok: false; error: string };

/** The helper's own words, after the sudoers rule matched: exactly `ensure-user <team>` or `run <team> <kind>`, nothing more. */
export function parseArgv(argv: readonly string[]): Parsed {
  const [command, team, kind, ...rest] = argv;
  if (command === 'ensure-user' && isSlug(team) && kind === undefined) return { ok: true, command, team };
  if (command === 'run' && isSlug(team) && isKind(kind) && rest.length === 0) return { ok: true, command, team, kind };
  if (command !== 'ensure-user' && command !== 'run') return { ok: false, error: 'the commands are ensure-user <team> and run <team> <kind>' };
  if (!isSlug(team)) return { ok: false, error: 'that is not a team slug (lower case letters, digits and single dashes, at most 63 characters)' };
  return { ok: false, error: command === 'run' ? 'the kinds are claude, codex, hermes, sync and clean-kube, and nothing follows them' : 'nothing follows the team in ensure-user' };
}

/** The program a kind starts, from the table: the command and its arguments, and the umask it runs with. `null` for a kind that starts none (clean-kube). */
export function programFor(cfg: HelperConfig, kind: Kind): { argv: string[]; umask: string } | null {
  if (kind === 'clean-kube') return null;
  if (kind === 'sync') {
    if (cfg.syncScript === undefined) throw new Error('this machine has no repository sync script');
    return { argv: ['/bin/sh', cfg.syncScript], umask: '0027' };
  }
  const p = cfg.agents[kind];
  if (p === undefined) throw new Error(`this machine has no ${kind} agent`);
  return { argv: [p.command, ...p.args], umask: '0007' };
}

// The three small programs run AS the team user. They are constants: nothing from a header is ever part of a program text, only an argument of it.
export const SH_MKDIR = 'umask "$1"; shift; mkdir -p -- "$@"';
export const SH_PUT = 'umask 077; d=$(dirname -- "$1") && mkdir -p -- "$d" && cat > "$1.new" && chmod "$2" "$1.new" && mv -f -- "$1.new" "$1"';
export const SH_RM = 'rm -rf -- "$@"';
export const SH_EXEC = 'umask "$1"; shift; cd -- "$1" && shift && exec "$@"';

/** The words that start `argv` as the user: numeric ids, the user's other groups, and the parent-death signal so the program dies when its launcher does. */
export function setprivArgv(setpriv: string, uid: number, gid: number, argv: readonly string[]): string[] {
  return [setpriv, '--reuid', String(uid), '--regid', String(gid), '--init-groups', '--pdeathsig', 'SIGKILL', '--', ...argv];
}

const which = (candidates: readonly string[]): string | null => candidates.find((c) => existsSync(c)) ?? null;
const sysEnv = (): NodeJS.ProcessEnv => ({ PATH: SYSTEM_PATH, LC_ALL: 'C' });

function run(cmd: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { encoding: 'utf8', env: sysEnv(), ...(input !== undefined ? { input } : {}), timeout: 60_000, maxBuffer: 1 << 20 });
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

/**
 * The sign-in folders are shared by the teams' users through the group `mt-agents`. A CLI that makes a file with mode 0600 (its own choice) would lock the other teams out of it, so every
 * file and folder below each agent's folder gets the group and the group's bits back (folders keep the setgid bit, so what they make there stays the group's). Run as root over folders that
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
  for (const agent of ['claude', 'codex']) {
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

/** Files, the working folder and the temporary folder: all made by the team's user. */
function prepare(plan: Plan, header: LaunchHeader, home: string): void {
  const dirs = asUser(plan, ['/bin/sh', '-c', SH_MKDIR, 'sh', '0077', posix.join(home, 'tmp')]);
  if (dirs.status !== 0) throw new Error('could not make the temporary folder');
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
  let program;
  try {
    program = programFor(cfg, parsed.kind);
    if (program === null) return 0;
    fixAuthFolders(cfg.dataRoot);
    prepare(plan, header, home);
  } catch (err) {
    say(err instanceof Error ? err.message : 'could not prepare the run');
    return 73;
  }
  const shell = which(['/bin/bash', '/bin/sh']) ?? '/bin/sh';
  const env = launchEnv(header, acct.name, home, shell);
  const [launcher, ...launcherArgs] = setprivArgv(plan.setpriv, acct.uid, acct.gid, ['/bin/sh', '-c', SH_EXEC, 'sh', program.umask, header.cwd, ...program.argv]);
  const child = spawn(launcher!, launcherArgs, { env, stdio: 'inherit', detached: true });
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
  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(74));
    child.on('exit', (c, sig) => resolve(c ?? (sig === null ? 1 : 128 + (({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1, SIGQUIT: 3 } as Record<string, number>)[sig] ?? 0))));
  });
  clearInterval(watch);
  clearInterval(fixer);
  // whatever the program left running in its group goes with it
  kill('SIGKILL');
  fixAuthFolders(cfg.dataRoot);
  remove(plan, header.removeAtEnd);
  return code;
}
