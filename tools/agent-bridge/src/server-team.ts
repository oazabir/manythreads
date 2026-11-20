import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { ServerModeConfig, TeamUsersConfig } from './config.ts';
import { startChild, type ChildHandle, type SpawnOptions } from './process.ts';
import { buildHeader, helperArgv, isSlug, isTeamUserName, teamHome, type Kind, type LaunchFile } from './team-user.ts';

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

  constructor(
    readonly server: ServerWithTeams,
    readonly team: string,
    readonly kind: Kind,
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

  /** Starts the program through the helper. The first line written is the header; what the caller writes after it reaches the program. */
  start(opts: SpawnOptions): ChildHandle {
    if (opts.stdin !== null) throw new Error('a team program talks over a pipe: it takes no prompt');
    const { command, args } = sudoArgv(this.server.teamUsers, this.team, this.kind);
    const child = startChild(command, args, { cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdin: null, onLine: opts.onLine });
    child.write(`${buildHeader({ cwd: opts.cwd, env: opts.env, files: this.files, removeAtEnd: this.removeAtEnd, kind: this.kind })}\n`);
    return child;
  }
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
    await new Promise<void>((resolve) => {
      const { command, args } = sudoArgv(server.teamUsers, team, kind);
      const child = startChild(command, args, { cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdin: null, onLine: () => undefined });
      child.write(`${buildHeader({ cwd: teamHome(server.root, team), env: {}, kind })}\n`);
      child.endInput();
      const timer = setTimeout(() => child.signal('SIGKILL'), 20_000);
      void child.done.then((end) => {
        clearTimeout(timer);
        if (end.code !== 0) log(`team ${team}: ${what}${end.stderrTail ? ` (${end.stderrTail.trim().split('\n').pop()?.slice(0, 150)})` : ''}`);
        resolve();
      });
    });
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
