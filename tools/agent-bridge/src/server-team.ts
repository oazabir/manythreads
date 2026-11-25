import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { ServerModeConfig, TeamUsersConfig } from './config.ts';
import { plainChunks, type PtyHandle } from './acp/pty.ts';
import { randomBytes } from 'node:crypto';
import { cgroupMemoryWatch, scopeMemoryWatch, type MemoryWatch } from './memory-watch.ts';
import { startChild, type ChildHandle, type SpawnOptions } from './process.ts';
import { buildHeader, helperArgv, isSlug, isTeamUserName, runScopeCgroupDir, teamHome, teamSigninDir, type Kind, type LaunchFile } from './team-user.ts';

// The bridge's side of the per-team users of an enrolled server (PLAN P26-22, docs/plans/agents-anywhere.md section 9b): it never starts a team's program itself. It asks the root helper
// (`team-helper.ts`) through `sudo -n`, which starts the fixed program as the team's own user. The run's environment, the files the run needs (the deployer's kubeconfig, Hermes' config) and the
// folders to remove when it ends go on the helper's standard input as one JSON line, and the rest of standard input is the adapter's own protocol. Nothing secret is in an argument.

export type { TeamUsersConfig };

export type ServerWithTeams = ServerModeConfig & { teamUsers: TeamUsersConfig };

export const hasTeamUsers = (server: ServerModeConfig | undefined): server is ServerWithTeams => server?.teamUsers !== undefined;

/** `sudo -n -- <helper> run <team> <kind>`: never asks for a password (it fails at once when the rule is missing), and the words after `--` are never read as sudo's own. */
export function sudoArgv(t: TeamUsersConfig, team: string, kind: Kind): { command: string; args: string[] } {
  return { command: t.sudo, args: ['-n', '--', ...helperArgv(t.helper, 'run', team, kind)] };
}

/** What a run asks of its team's user, collected while the run's profile is made, then sent with the program's first line. */
export class TeamRun {
  readonly files: LaunchFile[] = [];
  readonly removeAtEnd: string[] = [];
  /** The run's tag (P31-04): the helper names the run's scope after it (`mt-run-<team user>-<tag>.scope`), so the bridge knows where to read the run's memory. */
  readonly runTag: string = randomBytes(8).toString('hex');

  constructor(
    readonly server: ServerWithTeams,
    readonly team: string,
    readonly kind: Kind,
    /** `per_team`: the run is of a runner where each team signs in, and its tool's home is the team's own `.signin/<agent>` (the header says so; P35-10b). */
    readonly signIn?: 'per_team',
  ) {}

  /** A file written as the team's user before the program starts. `mode` is octal text like `0600`. */
  put(path: string, text: string, mode: string): void {
    const at = this.files.findIndex((f) => f.path === path);
    if (at >= 0) this.files[at] = { path, text, mode };
    else this.files.push({ path, text, mode });
  }

  /** A path removed as the team's user when the program ends, whatever way it ended. */
  removeWhenDone(path: string): void {
    if (!this.removeAtEnd.includes(path)) this.removeAtEnd.push(path);
  }

  /** What tells a command of this run that was stopped for memory: its scope, where the helper made one, else the bridge's own group (memory-watch.ts). */
  memoryWatch(): MemoryWatch | null {
    return scopeMemoryWatch(runScopeCgroupDir(this.team, this.runTag), cgroupMemoryWatch());
  }

  /** Starts the program through the helper. The first line written is the header; what the caller writes after it reaches the program. */
  start(opts: SpawnOptions): ChildHandle {
    if (opts.stdin !== null) throw new Error('a team program talks over a pipe: it takes no prompt');
    const { command, args } = sudoArgv(this.server.teamUsers, this.team, this.kind);
    const child = startChild(command, args, { cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdin: null, onLine: opts.onLine });
    child.write(`${buildHeader({ cwd: opts.cwd, env: opts.env, files: this.files, removeAtEnd: this.removeAtEnd, kind: this.kind, signIn: this.signIn, runTag: this.runTag })}\n`);
    return child;
  }

  /**
   * A program that needs a terminal (`claude-login`, `claude-logout`), started through the helper, which makes the terminal itself as the team user (P35-10b, plan section 7). The header
   * goes on the plain pipe first, before any terminal exists, so no echo can show it; what the program prints comes back as plain text, and `writeLine` types a line into its terminal
   * (the text, then Enter as a carriage return a moment later, as `startPty` does).
   */
  startTerminal(opts: { cwd: string; env: NodeJS.ProcessEnv; onText: (text: string) => void }): PtyHandle {
    if (this.kind !== 'claude-login' && this.kind !== 'claude-logout') throw new Error('only a sign-in kind runs under a terminal');
    const { command, args } = sudoArgv(this.server.teamUsers, this.team, this.kind);
    const child = spawn(command, args, { cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child.stdin?.on('error', () => undefined);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', plainChunks(opts.onText));
    child.stderr?.resume();
    child.stdin?.write(`${buildHeader({ cwd: opts.cwd, env: opts.env, kind: this.kind })}\n`);
    let exited = false;
    let spawnError: string | null = null;
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>((resolve) => {
      child.on('error', (err) => {
        spawnError = (err as NodeJS.ErrnoException).code ?? 'error';
      });
      child.on('close', (code, signal) => {
        exited = true;
        resolve({ code, signal, spawnError });
      });
    });
    return {
      get exited() {
        return exited;
      },
      writeLine: (text) => {
        const stdin = child.stdin;
        if (exited || !stdin || stdin.destroyed || stdin.writableEnded) return false;
        stdin.write(text);
        const enter = setTimeout(() => {
          if (!exited && !stdin.destroyed && !stdin.writableEnded) stdin.write('\r');
        }, 100);
        enter.unref();
        return true;
      },
      // sudo hands the signal to the helper, which ends the program's whole group
      signal: (sig) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      },
      done,
    };
  }
}

/** The variable that names a team's own sign-in folder of an agent, and the folder. */
export const teamSigninEnv = (server: ServerWithTeams, team: string, agent: 'claude' | 'codex'): Record<string, string> =>
  agent === 'claude' ? { CLAUDE_CONFIG_DIR: teamSigninDir(server.root, team, 'claude') } : { CODEX_HOME: teamSigninDir(server.root, team, 'codex') };

/** Asks the helper for one start-nothing kind for one team and waits (20 s at most). Resolves with the exit code (null: killed) and the lines it printed, never rejects. */
export function helperOnce(server: ServerWithTeams, team: string, kind: Kind, env: Record<string, string> = {}): Promise<{ code: number | null; stderrTail: string; lines: string[] }> {
  return new Promise((resolve) => {
    const { command, args } = sudoArgv(server.teamUsers, team, kind);
    const lines: string[] = [];
    const child = startChild(command, args, { cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdin: null, onLine: (l) => void (lines.length < 20 && lines.push(l.slice(0, 2000))) });
    child.write(`${buildHeader({ cwd: teamHome(server.root, team), env, kind })}\n`);
    child.endInput();
    const timer = setTimeout(() => child.signal('SIGKILL'), 20_000);
    void child.done.then((end) => {
      clearTimeout(timer);
      resolve({ code: end.code, stderrTail: end.stderrTail, lines });
    });
  });
}

/**
 * What a team's own sign-in file says about its dates (`signin-facts`, read by the helper as the team user; no token comes back). Null when the helper could not tell: the gate then
 * holds the team's runs one at a time, as it would near a renewal.
 */
export async function teamSigninFacts(server: ServerWithTeams, team: string, agent: 'claude' | 'codex'): Promise<{ exists: boolean; valid: boolean; expiresAt: number | null; refreshedAt: number | null; mtimeMs: number | null } | null> {
  const end = await helperOnce(server, team, 'signin-facts', teamSigninEnv(server, team, agent));
  if (end.code !== 0) return null;
  try {
    const v = JSON.parse(end.lines.find((l) => l.trim().startsWith('{')) ?? '') as Record<string, unknown>;
    const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return { exists: v['exists'] === true, valid: v['valid'] === true, expiresAt: num(v['expiresAt']), refreshedAt: num(v['refreshedAt']), mtimeMs: num(v['mtimeMs']) };
  } catch {
    return null;
  }
}

/** Removes a team's own sign-in folder of one agent, as the team user (`clean-signin`). True when the helper said it was done. */
export async function cleanTeamSignin(server: ServerWithTeams, team: string, agent: 'claude' | 'codex'): Promise<boolean> {
  return (await helperOnce(server, team, 'clean-signin', teamSigninEnv(server, team, agent))).code === 0;
}

const made = new Map<string, Promise<void>>();

/** Asks the helper to make the team's user (once per team for as long as the bridge runs; a failure is asked again next time). Rejects with the helper's own plain sentence. */
export function ensureTeamUser(t: TeamUsersConfig, team: string, exec: typeof execFile = execFile): Promise<void> {
  const key = `${t.sudo}\0${t.helper}\0${team}`;
  const have = made.get(key);
  if (have !== undefined) return have;
  const p = new Promise<void>((resolve, reject) => {
    exec(t.sudo, ['-n', '--', ...helperArgv(t.helper, 'ensure-user', team)], { timeout: 60_000, env: { PATH: '/usr/local/bin:/usr/bin:/bin' } }, (err, _out, stderr) => {
      if (err === null) return resolve();
      const line = String(stderr).split('\n').map((l) => l.trim()).filter((l) => l !== '').pop();
      reject(new Error(`the user for team ${team} could not be made on this server${line !== undefined ? `: ${line.slice(0, 200)}` : ''}`));
    });
  });
  made.set(key, p);
  p.catch(() => made.delete(key));
  return p;
}

/** The slugs of the teams that have a user here: the passwd file's `mt-team-*` accounts whose home is `<root>/work/<slug>`. */
export function teamsOnMachine(root: string, passwd: string): string[] {
  const out: string[] = [];
  for (const line of passwd.split('\n')) {
    const f = line.split(':');
    const name = f[0];
    const home = f[5];
    if (name === undefined || home === undefined || !isTeamUserName(name) || posix.dirname(home) !== posix.join(root, 'work')) continue;
    const team = posix.basename(home);
    if (isSlug(team) && home === teamHome(root, team)) out.push(team);
  }
  return out;
}

/** Asks the helper for one start-nothing kind (`clean-kube`, `clean-codex`) for every team that has a user here, one after another. One team that fails is logged and the rest go on. */
async function cleanEachTeam(server: ServerWithTeams, kind: 'clean-kube' | 'clean-codex', what: string, log: (line: string) => void, passwdFile: string): Promise<void> {
  let teams: string[] = [];
  try {
    teams = teamsOnMachine(server.root, readFileSync(passwdFile, 'utf8'));
  } catch {
    return;
  }
  for (const team of teams) {
    const end = await helperOnce(server, team, kind);
    if (end.code !== 0) log(`team ${team}: ${what}${end.stderrTail ? ` (${end.stderrTail.trim().split('\n').pop()?.slice(0, 150)})` : ''}`);
  }
}

/** At start-up: no run survives a restart, so every team's kube folder is emptied (the helper does it as the team's user). */
export function cleanTeamKube(server: ServerWithTeams, log: (line: string) => void, passwdFile = '/etc/passwd'): Promise<void> {
  return cleanEachTeam(server, 'clean-kube', 'the old kubeconfig folder could not be emptied', log, passwdFile);
}

/**
 * Every team's copy of the Codex sign-in is removed (the helper does it as the team's user; the team's sessions and state stay): at start-up, because no run survived, and after a
 * sign-out, so no copy outlives the main one (P31-01). One team per helper call, never a word like "all": the helper takes exactly `run <team> clean-codex`.
 */
export function cleanTeamCodex(server: ServerWithTeams, log: (line: string) => void, passwdFile = '/etc/passwd'): Promise<void> {
  return cleanEachTeam(server, 'clean-codex', 'its copy of the Codex sign-in could not be removed', log, passwdFile);
}
