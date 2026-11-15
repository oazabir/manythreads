import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRepoList, toLines, writeRepoList } from './repos.ts';

// The repository sync of an enrolled server (PLAN P26-15, docs/plans/agents-anywhere.md section 5.6). A pod's controller sends its list to `PUT /internal/repos`; a server has no controller,
// so the bridge asks the site for it with its own key (`GET /api/bridge/repos`), writes the file the sync step reads, and keeps that step (the pod's own `repo-sync.sh`, from the bundle's
// `tools` folder) running as its child: clones into each bot's folder, the team's repository of record under `<root>/work/<team>/repos`, no credential written anywhere (public addresses only).

export interface ServerReposOptions {
  siteUrl: string;
  /** The bridge key, read at every poll (a rotation changes it). */
  key: () => string;
  /** The folder with `repo-sync.sh`. */
  toolsDir: string;
  /** The bridge's data folder (`server.root`); the clones are under `<root>/work`. */
  root: string;
  /** The bridge's state folder: the list and the sync step's scratch folder live in it. */
  stateDir: string;
  intervalMs?: number;
  /** Seconds between the sync step's own passes (its default is 5); a server does not need that often. */
  syncSeconds?: number;
  /** Test hook: how long before an ended sync step is started again (default five seconds). */
  restartMs?: number;
  fetch?: typeof fetch;
  log: (line: string) => void;
}

export interface ServerRepos {
  /** Ask the site once and write the list when it changed. Never throws. Returns whether the list on disk is current. */
  poll(): Promise<boolean>;
  close(): Promise<void>;
}

const RESTART_MS = 5_000;

export function startServerRepos(options: ServerReposOptions): ServerRepos {
  const doFetch = options.fetch ?? fetch;
  const listFile = join(options.stateDir, 'repos.txt');
  const scratch = join(options.stateDir, 'sync');
  const work = join(options.root, 'work');
  let last: string | null = null;
  let child: ChildProcess | undefined;
  let closed = false;
  let restart: NodeJS.Timeout | undefined;
  let complained = '';
  const complain = (what: string): void => {
    // one line per kind of trouble until it goes away: a site that is down for an hour must not fill the journal
    if (complained !== what) options.log(`repo sync: ${what}`);
    complained = what;
  };

  const poll = async (): Promise<boolean> => {
    let res: Response;
    try {
      res = await doFetch(`${options.siteUrl.replace(/\/+$/, '')}/api/bridge/repos`, { headers: { authorization: `Bearer ${options.key()}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    } catch {
      complain('the site did not answer; the list stays as it was');
      return false;
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      complain(res.status === 401 ? 'the site does not accept this key; the list stays as it was' : `the site answered ${res.status}; the list stays as it was`);
      return false;
    }
    const parsed = parseRepoList(await res.json().catch(() => null));
    if (!parsed.ok) {
      complain(`the site's list was refused (${parsed.error})`);
      return false;
    }
    complained = '';
    const text = toLines(parsed.repos);
    if (text !== last) {
      writeRepoList(listFile, parsed.repos);
      last = text;
      options.log(`repo sync: ${parsed.repos.length} repositor${parsed.repos.length === 1 ? 'y' : 'ies'} on the list`);
    }
    return true;
  };

  const startChild = (): void => {
    if (closed) return;
    mkdirSync(scratch, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: scratch,
      LANG: 'C.UTF-8',
      REPO_SYNC_LIST: listFile,
      // a pod's second source (its ConfigMap) does not exist here
      REPO_SYNC_FALLBACK: join(options.stateDir, 'no-such-list'),
      REPO_SYNC_WORK: work,
      REPO_SYNC_SCRATCH: scratch,
      ...(options.syncSeconds !== undefined ? { REPO_SYNC_INTERVAL: String(options.syncSeconds) } : {}),
    };
    const c = spawn('sh', [join(options.toolsDir, 'repo-sync.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child = c;
    const forward = (d: Buffer): void => {
      for (const line of d.toString().split('\n')) if (line.trim() !== '') options.log(`repo sync: ${line.slice(0, 300)}`);
    };
    c.stdout?.on('data', forward);
    c.stderr?.on('data', forward);
    c.on('error', () => options.log('repo sync: the sync step could not be started'));
    c.on('exit', (code, signal) => {
      child = undefined;
      if (closed) return;
      options.log(`repo sync: the sync step ended (${signal ?? code}); starting it again`);
      restart = setTimeout(startChild, options.restartMs ?? RESTART_MS);
      restart.unref();
    });
  };

  // the list is there before the step starts, so its first pass already has work; an unanswered first poll leaves an empty list
  void (async () => {
    if (!(await poll())) {
      try {
        readFileSync(listFile);
      } catch {
        writeRepoList(listFile, []);
      }
    }
    startChild();
  })();
  const timer = setInterval(() => void poll(), options.intervalMs ?? 30_000);
  timer.unref();

  return {
    poll,
    async close() {
      closed = true;
      clearInterval(timer);
      clearTimeout(restart);
      const c = child;
      if (c?.pid !== undefined) {
        const ended = new Promise<void>((r) => c.once('exit', () => r()));
        try {
          process.kill(-c.pid, 'SIGTERM');
        } catch {
          return;
        }
        await Promise.race([ended, new Promise((r) => setTimeout(r, 3000))]);
        try {
          process.kill(-c.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    },
  };
}
