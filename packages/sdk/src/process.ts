import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

// How an agent process is run on a host (SPEC §7.1, §7.4): a profile directory written owner-only, a child that leads its own process
// group, a stop that signals the group, and a profile that is removed only once nothing of the run is left in it. Two programs do exactly
// this — the server's Hermes provider (`runtime-hermes`, the agent inside the server's own pod) and the runner (`packages/runner`, the
// agent on another machine) — so it lives here once, and neither copies it. Server-only: it uses `node:` modules and child processes.
//
// Both import it from `@manythreads/sdk/process`: a plugin may import only the SDK and `@manythreads/shared`, and the runner is not
// allowed to import the kernel or a plugin, so the one place both can reach is a subpath of the SDK.

/**
 * The only parent variables an agent child inherits: what a program needs to find its binaries, its locale and its clock, and Hermes' own
 * `HERMES_*` settings. Everything else in the parent's environment — the KMS key, the database URLs and their passwords, the LiteLLM master
 * key, the test auth token, a runner's own token — stays with the parent. A run's authority is its profile (the bot's key and the run's
 * token), never the platform's credentials, so an agent that runs a shell tool (`env`, `/proc/self/environ`) finds none of them.
 */
const ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  // Where a TLS client finds its trust roots: a deployment behind a private CA (or a proxy that re-signs) names them here, and
  // an agent without them cannot reach the model gateway at all. Paths, not credentials.
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS',
]);
const ENV_PREFIXES = ['LC_', 'HERMES_'];

/**
 * Names an operator may never pass through, whatever the pass-through list says: the platform's own settings and credentials
 * (`MANYTHREADS_*`) and the database's (`DATABASE*`, `PG*`). The opt-in exists for `HTTPS_PROXY`, `NO_PROXY` and the like.
 */
const PASSTHROUGH_REFUSED = /^(?:MANYTHREADS_|DATABASE|PG)/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The extra names a comma-separated opt-in list lets through, with the refused ones dropped. */
export function passthroughNames(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => ENV_NAME.test(name) && !PASSTHROUGH_REFUSED.test(name));
}

/**
 * The child's environment: the allowlisted part of `source`, plus the operator's opt-in names (`MANYTHREADS_HERMES_ENV_PASSTHROUGH`, read
 * from `source` itself) minus anything `PASSTHROUGH_REFUSED`. The caller adds `HERMES_HOME`.
 */
export function childEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra = new Set(passthroughNames(source['MANYTHREADS_HERMES_ENV_PASSTHROUGH']));
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(name) || ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) || extra.has(name)) env[name] = value;
  }
  return env;
}

/** Written into every profile this code creates; the sweep deletes only directories that carry it. */
export const PROFILE_MARKER = '.manythreads-profile';

/** `<bot slug>-<run uuid>` (or `-no-run`): the only names a profile home has. The sweep never looks at anything else. */
const PROFILE_DIR_NAME = /^[a-z0-9][a-z0-9._-]*-(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|no-run)$/;

/** Whether `home` has the shape of a profile home for run `runId`: `<bot slug>-<runId>`, nothing else (never `default`, never a path). */
export function isProfileHomeFor(home: string, runId: string): boolean {
  return PROFILE_DIR_NAME.test(home) && home.endsWith(`-${runId}`) && home.length > runId.length + 1;
}

/**
 * Whether this directory is one of ours and holds nothing but the `logs/` Hermes writes as it exits.
 *
 * The removal at the end of a run is a `rm -rf` racing a process that is finishing: Hermes can write its log directory after the
 * files (the run token, the bot's key) are already gone, which leaves a named husk with no marker for the sweep to recognise. A
 * directory named `<slug>-<run uuid>` whose only entry is `logs/`, holding nothing but `*.log` files, is that husk and nothing
 * else.
 */
async function isProfileHusk(path: string): Promise<boolean> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (entries === null || entries.length !== 1) return false;
  const only = entries[0];
  if (only?.name !== 'logs' || !only.isDirectory()) return false;
  const logs = await readdir(resolve(path, 'logs'), { withFileTypes: true }).catch(() => null);
  return logs !== null && logs.every((entry) => entry.isFile() && entry.name.endsWith('.log'));
}

/**
 * Remove profile directories a crashed or killed process left behind (a profile holds the run token and the bot's key and is removed when
 * its run ends; a process that died mid-run never got to). Called once at startup; only directories that (1) are named the way a profile
 * home is named, (2) carry `PROFILE_MARKER` (or are the empty husk `isProfileHusk` describes) and (3) are older than `maxAgeMs` go — so an
 * operator who points the data root at a directory with other things in it loses none of them, and a profile another replica sharing the
 * directory is using right now is left alone. Answers how many went.
 */
export async function sweepStaleProfiles(dataRoot: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dataRoot);
  } catch {
    return 0; // no directory yet: nothing to sweep
  }
  let removed = 0;
  for (const name of names) {
    if (!PROFILE_DIR_NAME.test(name)) continue;
    const path = resolve(dataRoot, name);
    try {
      const info = await stat(path);
      if (!info.isDirectory()) continue;
      // A husk cannot be a live run's profile (that one holds `config.yaml` and `SOUL.md`), so its age is not evidence either way: it
      // goes at once. A marked profile keeps the age rule, which is what leaves another replica's run alone.
      const husk = await isProfileHusk(path);
      const marked = await stat(resolve(path, PROFILE_MARKER)).then((s) => s.isFile(), () => false);
      if (!husk && (!marked || now - info.mtimeMs < maxAgeMs)) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // raced with the run that owns it, no marker, or unreadable: leave it for the next start
    }
  }
  return removed;
}

/** Everything the profile directory needs to be written, in order, with `..` and absolute paths refused. */
export function profilePaths(dataRoot: string, home: string, files: Record<string, string>): { dir: string; written: [string, string][] } {
  const root = resolve(dataRoot);
  const dir = resolve(root, home);
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error(`refusing to render outside ${root}`);
  const written: [string, string][] = [];
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(dir, path);
    if (!target.startsWith(dir + sep)) throw new Error(`refusing to write ${path} outside the profile`);
    written.push([target, content]);
  }
  return { dir, written };
}

/**
 * Write a profile: the data root and the profile directory owner-only (0700), the marker first (so a crash between here and the end of the
 * run leaves a directory the startup sweep may remove), then each file 0600. The caller removes the directory with `removeProfileDir`,
 * also when whatever it does next fails.
 */
export async function writeProfile(dataRoot: string, home: string, files: Record<string, string>): Promise<string> {
  const { dir, written } = profilePaths(dataRoot, home, files);
  await mkdir(resolve(dataRoot), { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(resolve(dir, PROFILE_MARKER), 'manythreads runtime profile: removed when its run ends\n', { encoding: 'utf8', mode: 0o600 });
  for (const [target, content] of written) await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  return dir;
}

/**
 * Remove a profile directory and keep it removed. A process that is still finishing can recreate its log directory after the removal
 * (Hermes' state registry writes `logs/` as it shuts down), so a removal only counts once the directory has stayed gone through two quiet
 * checks. Answers whether it is gone; what must not stay behind is the file holding the run's token and the bot's key.
 */
export async function removeProfileDir(dir: string): Promise<boolean> {
  let quiet = 0;
  for (let attempt = 0; attempt < 6 && quiet < 2; attempt += 1) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    quiet = existsSync(dir) ? 0 : quiet + 1;
  }
  return !existsSync(dir);
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface GroupProcessOptions {
  /** Injectable for tests; the real `node:child_process.spawn`. */
  spawn?: typeof nodeSpawn;
  bin: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed: the prompt never goes in an argv a process list shows. */
  stdin: string;
  /** Between SIGTERM and SIGKILL. */
  killGraceSeconds: number;
  /** The hard ceiling is this plus the grace: a wedged process would otherwise hold its worker forever. */
  budgetSeconds: number;
  /** Called once when the ceiling is reached, just before the stop. */
  onCeiling?: (budgetSeconds: number) => void;
}

export interface GroupProcess {
  /** The child's stdout, a line at a time (null when the child has no stdout). Collected from spawn on, not from the first read. */
  lines: AsyncIterator<string> | null;
  /** Resolves when the child has closed (or failed to start). Listened for at spawn, so an immediate failure is never missed. */
  exited: Promise<ProcessExit>;
  /** The last 2000 characters of stderr: a dying process can print a lot, and a log line is one sentence. */
  stderrTail(): string;
  /** Signal the whole group with SIGTERM now and SIGKILL after the grace. Idempotent. */
  kill(): Promise<void>;
  /** Wait until the group has no member left (or the grace and two seconds have passed) and clear the timers. Call before removing a profile. */
  settle(): Promise<void>;
}

/**
 * Start a child that leads its own process group, so a stop reaches whatever the agent started (a shell tool's children) and not only
 * the leader. Not on Windows, where `detached` opens a console window and there are no groups to signal.
 */
export function startGroupProcess(options: GroupProcessOptions): GroupProcess {
  const spawn = options.spawn ?? nodeSpawn;
  const useGroups = process.platform !== 'win32';
  const child: ChildProcess = spawn(options.bin, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: useGroups,
  });
  // A child that exits before reading its prompt closes the pipe: the write error is the child's failure to report (the
  // exit handler below does), not an unhandled 'error' event that would take the process down.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(options.stdin);
  // The exit is listened for *here*, not when the stream is first read: a binary that fails immediately (a wrong argv, a
  // missing model) can be gone before the job takes its first event, and a listener attached afterwards would wait for a
  // `close` that already happened — a run that never ends holds its job worker forever.
  const exited = new Promise<ProcessExit>((resolveExit) => {
    child.once('error', () => resolveExit({ code: null, signal: null }));
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000);
  });

  // The child leads its own process group (`detached`), and the group — not the leader — is what a stop is about: the leader
  // can exit (normally, or by SIGTERM) while a shell tool's children go on running. So "is there anything left to signal"
  // is asked of the group (`kill(-pid, 0)`: ESRCH means no member is left), never of `child.exitCode`.
  let groupGone = !useGroups || typeof child.pid !== 'number';
  /** Whether any member of the child's process group is still there. Once it is gone the pid may be reused: never signal again. */
  const groupExists = (): boolean => {
    if (groupGone || typeof child.pid !== 'number') return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true; // exists, not ours to signal: treat as present
      groupGone = true; // ESRCH
      return false;
    }
  };
  /** Signal the whole group while it exists; with no group to hit (a platform without them, a stand-in child) the child alone. */
  const signal = (name: NodeJS.Signals): void => {
    if (useGroups && typeof child.pid === 'number') {
      if (!groupExists()) return;
      try {
        process.kill(-child.pid, name);
        return;
      } catch {
        // gone between the probe and the signal, or not ours: fall through to the child itself
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(name);
  };
  const groupGoneWithin = async (ms: number): Promise<void> => {
    const deadline = Date.now() + ms;
    while (groupExists() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  };
  let killTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  const kill = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    signal('SIGTERM');
    killTimer = setTimeout(() => signal('SIGKILL'), options.killGraceSeconds * 1000);
    killTimer.unref?.();
  };

  const budget = options.budgetSeconds + options.killGraceSeconds;
  const ceiling = setTimeout(() => {
    options.onCeiling?.(budget);
    void kill();
  }, budget * 1000);
  ceiling.unref?.();

  // The stdout lines are collected from the moment the process exists, not from the moment the job first asks for an event: a process
  // that has already exited and been reaped has already ended and destroyed its stdout, and a reader attached after that never sees
  // an end (the stream is gone, and no 'close' is coming), so the run would hold its job worker forever.
  const lines = child.stdout ? createInterface({ input: child.stdout })[Symbol.asyncIterator]() : null;
  return {
    lines,
    exited,
    stderrTail: () => stderr,
    kill,
    settle: async () => {
      clearTimeout(ceiling);
      // The profile (token, key) goes only once nothing of the run is left in it: after the group is gone, or after the
      // SIGTERM grace plus the SIGKILL's turn, whichever comes first.
      await groupGoneWithin(options.killGraceSeconds * 1000 + 2_000);
      clearTimeout(killTimer);
    },
  };
}

/**
 * The argv after the Hermes binary for one turn: one one-shot query read from stdin (`--query-file -`, so a message body is never
 * shell-interpreted and never lands in an argv a process list shows), structured JSONL on stdout, and the definition's budgets.
 */
export function hermesChatArgs(limits: { runBudgetSeconds: number | null; maxTurns: number | null }): string[] {
  const args = ['chat', '--query-file', '-', '--oneshot', '--format', 'stream-json'];
  if (limits.runBudgetSeconds !== null) args.push('--run-budget', String(limits.runBudgetSeconds));
  if (limits.maxTurns !== null) args.push('--max-turns', String(limits.maxTurns));
  return args;
}
