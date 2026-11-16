import { posix } from 'node:path';
import { startChild, type ChildHandle } from './process.ts';
import type { RepoLine } from './repos.ts';
import { toLines } from './repos.ts';
import { ensureTeamUser, sudoArgv, type ServerWithTeams } from './server-team.ts';
import { buildHeader, isSlug, teamHome } from './team-user.ts';

// The repository sync of a server whose teams have their own users (PLAN P26-22): one copy of the pod's `repo-sync.sh` per team, started by the root helper AS that team's user, with only
// that team's lines of the list. It therefore writes the team's clones and its repository of record inside the team's home (0700 for everybody else), and a team's sync can never touch
// another team's folders: they are not its own. The list goes to the helper in the header (the helper writes it into the team's home as that user); a changed list restarts that team's step,
// which does one pass at once.

export interface TeamSync {
  /** The whole list as the site sent it: starts the step of a team that is new on it, restarts one whose lines changed, stops one that left it. */
  update(repos: readonly RepoLine[]): void;
  close(): Promise<void>;
}

export interface TeamSyncOptions {
  server: ServerWithTeams;
  /** Seconds between the sync step's own passes. */
  syncSeconds?: number | undefined;
  /** How long before an ended step is started again (default five seconds). */
  restartMs?: number | undefined;
  log: (line: string) => void;
  /** Test hook: starts the step (default: through the helper). */
  start?: ((team: string, text: string) => ChildHandle) | undefined;
}

interface Entry {
  text: string;
  child: ChildHandle | undefined;
  restart: NodeJS.Timeout | undefined;
  stopping: boolean;
}

export function startTeamSync(options: TeamSyncOptions): TeamSync {
  const { server } = options;
  const entries = new Map<string, Entry>();
  let closed = false;

  const defaultStart = (team: string, text: string): ChildHandle => {
    const home = teamHome(server.root, team);
    const sync = posix.join(home, '.sync');
    const { command, args } = sudoArgv(server.teamUsers, team, 'sync');
    const child = startChild(command, args, {
      cwd: '/',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdin: null,
      onLine: (line) => {
        if (line.trim() !== '') options.log(`repo sync ${team}: ${line.slice(0, 300)}`);
      },
    });
    child.write(
      `${buildHeader({
        cwd: sync,
        kind: 'sync',
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          REPO_SYNC_LIST: posix.join(sync, 'list.txt'),
          REPO_SYNC_FALLBACK: posix.join(sync, 'no-such-list'),
          REPO_SYNC_WORK: posix.join(server.root, 'work'),
          REPO_SYNC_SCRATCH: posix.join(sync, 'scratch'),
          ...(options.syncSeconds !== undefined ? { REPO_SYNC_INTERVAL: String(options.syncSeconds) } : {}),
        },
        files: [{ path: posix.join(sync, 'list.txt'), text, mode: '0600' }],
      })}\n`,
    );
    return child;
  };
  const start = options.start ?? defaultStart;

  const launch = (team: string, entry: Entry): void => {
    if (closed || entry.stopping) return;
    ensureTeamUser(server.teamUsers, team)
      .then(() => {
        if (closed || entry.stopping) return;
        const child = start(team, entry.text);
        entry.child = child;
        void child.done.then((end) => {
          if (entry.child === child) entry.child = undefined;
          if (closed || entry.stopping) return;
          options.log(`repo sync ${team}: the sync step ended (${end.signal ?? end.code}${end.stderrTail.trim() !== '' ? `: ${end.stderrTail.trim().split('\n').pop()?.slice(0, 150)}` : ''}); starting it again`);
          entry.restart = setTimeout(() => launch(team, entry), options.restartMs ?? 5000);
          entry.restart.unref();
        });
      })
      .catch((err: unknown) => {
        options.log(`repo sync ${team}: ${err instanceof Error ? err.message : 'the sync step could not be started'}; trying again`);
        entry.restart = setTimeout(() => launch(team, entry), options.restartMs ?? 5000);
        entry.restart.unref();
      });
  };

  const stop = async (entry: Entry): Promise<void> => {
    entry.stopping = true;
    clearTimeout(entry.restart);
    const child = entry.child;
    if (child === undefined) return;
    child.signal('SIGTERM');
    const kill = setTimeout(() => child.signal('SIGKILL'), 3000);
    await child.done;
    clearTimeout(kill);
  };

  return {
    update(repos) {
      if (closed) return;
      const byTeam = new Map<string, RepoLine[]>();
      for (const r of repos) {
        if (!isSlug(r.team)) continue;
        byTeam.set(r.team, [...(byTeam.get(r.team) ?? []), r]);
      }
      for (const [team, entry] of entries) {
        if (!byTeam.has(team)) {
          void stop(entry);
          entries.delete(team);
        }
      }
      for (const [team, lines] of byTeam) {
        const text = toLines(lines);
        const have = entries.get(team);
        if (have?.text === text) continue;
        const entry: Entry = { text, child: undefined, restart: undefined, stopping: false };
        entries.set(team, entry);
        if (have === undefined) launch(team, entry);
        else void stop(have).then(() => launch(team, entry));
      }
    },
    async close() {
      closed = true;
      await Promise.all([...entries.values()].map((e) => stop(e)));
      entries.clear();
    },
  };
}
