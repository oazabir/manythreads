import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// The only place that starts a `git` process. Rules (PLAN P4-03): argv only (never a shell string), an environment built from
// scratch (no inherited GIT_*), no hooks, no transports, no user or system configuration, a timeout and an output cap on every call,
// and a bounded number of processes at once.

export type GitErrorCode =
  | 'timeout' // the process ran past its deadline and was killed
  | 'output_too_large' // it wrote more than the cap allows and was killed
  | 'failed' // it exited non-zero
  | 'ref_conflict' // update-ref found the ref at another sha than the expected one (the compare-and-swap lost)
  | 'busy' // too many calls waiting for a process slot: refused at once (503), not queued without bound
  | 'unavailable'; // git could not be started

export class GitError extends Error {
  override readonly name = 'GitError';
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly exitCode: number | null = null,
    readonly stderr = '',
  ) {
    super(message);
  }
}

export interface GitRunOptions {
  /** The repository (`--git-dir`). Omitted for `init`. */
  gitDir?: string;
  /** Working directory (default: the git dir, else the temp directory). */
  cwd?: string;
  /** Written to the process's stdin. */
  input?: Uint8Array | string;
  timeoutMs?: number;
  /** Cap on stdout bytes. */
  maxOutputBytes?: number;
  /** `truncate` keeps the first `maxOutputBytes` and reports `truncated`; the default `error` rejects with `output_too_large`. */
  onOverflow?: 'error' | 'truncate';
  /** Exit codes that are not failures (default: 0 only). */
  okExit?: readonly number[];
  /** Per-call environment; only the keys of `ALLOWED_ENV` are accepted (index file, author and committer identity). */
  env?: Readonly<Record<string, string>>;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface GitRunner {
  readonly bin: string;
  run(args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
  /** Processes running now, and calls waiting for a slot (for tests and metrics). */
  stats(): { running: number; waiting: number };
}

export interface GitRunnerOptions {
  /** The git executable (default `MANYTHREADS_GIT_BIN`, else `git`). */
  bin?: string;
  /** Most processes at once in this runner (default `MANYTHREADS_GIT_WORKERS`, else 8). */
  poolSize?: number;
  /** Calls allowed to wait for a slot; one more is refused with `busy` (default `MANYTHREADS_GIT_MAX_QUEUE`, else 64). */
  maxQueue?: number;
  /** Most processes one repository may run at once, so a team hammering its history cannot take every slot (default: the pool minus two, so two slots stay free for other teams; a pool of one or two has no cap). */
  perRepoMax?: number;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
}

export const ALLOWED_ENV: ReadonlySet<string> = new Set([
  'GIT_INDEX_FILE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

/** Settings that make every call safe whatever the repository's own config says. */
const SAFE_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'protocol.allow=never',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.pager=cat',
  'core.attributesFile=/dev/null',
  'diff.external=',
  'gc.auto=0',
  'maintenance.auto=false',
  'safe.bareRepository=all',
];

const STDERR_CAP = 64 * 1024;

/** The environment of a git process: built from scratch, so no `GIT_DIR`, `GIT_EXEC_PATH`, `GIT_SSH_COMMAND`... leaks in. */
function buildEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/nonexistent',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    // A path from a user is a name, never a pattern: `pages/*`, `:(glob)**` and `:(top)` would otherwise widen history, diff and log (L1 of the Phase 4 review).
    GIT_LITERAL_PATHSPECS: '1',
    GIT_PAGER: 'cat',
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (!ALLOWED_ENV.has(key)) throw new GitError('failed', `environment variable ${key} is not allowed for git`);
    env[key] = value;
  }
  return env;
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const bin = options.bin ?? process.env['MANYTHREADS_GIT_BIN'] ?? 'git';
  const poolSize = Math.max(1, options.poolSize ?? (Number(process.env['MANYTHREADS_GIT_WORKERS']) || 8));
  const defaultTimeout = options.defaultTimeoutMs ?? 20_000;
  const defaultMax = options.defaultMaxOutputBytes ?? 8 * 1024 * 1024;
  const maxQueue = Math.max(0, options.maxQueue ?? (Number(process.env['MANYTHREADS_GIT_MAX_QUEUE']) || 64));
  const perRepoMax = Math.max(1, options.perRepoMax ?? (poolSize <= 2 ? poolSize : poolSize - 2));
  let running = 0;
  const perRepo = new Map<string, number>();
  const waiting: { key: string; start: () => void }[] = [];
  const canStart = (key: string): boolean => running < poolSize && (perRepo.get(key) ?? 0) < perRepoMax;
  const take = (key: string): void => {
    running += 1;
    perRepo.set(key, (perRepo.get(key) ?? 0) + 1);
  };

  const acquire = (key: string): Promise<void> => {
    if (canStart(key)) {
      take(key);
      return Promise.resolve();
    }
    if (waiting.length >= maxQueue) return Promise.reject(new GitError('busy', `git is busy: ${waiting.length} calls are already waiting`));
    return new Promise((resolve) => waiting.push({ key, start: resolve }));
  };
  /** Frees a slot and hands free capacity to the oldest waiters that may run (a waiter whose repository is at its own cap is passed over, not blocked on). */
  const release = (key: string): void => {
    running -= 1;
    const n = (perRepo.get(key) ?? 1) - 1;
    if (n <= 0) perRepo.delete(key);
    else perRepo.set(key, n);
    for (let i = 0; i < waiting.length && running < poolSize; ) {
      const w = waiting[i]!;
      if (canStart(w.key)) {
        waiting.splice(i, 1);
        take(w.key);
        w.start();
      } else i += 1;
    }
  };

  const spawnOnce = (args: readonly string[], opts: GitRunOptions): Promise<GitResult> =>
    new Promise<GitResult>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? defaultTimeout;
      const maxOut = opts.maxOutputBytes ?? defaultMax;
      const okExit = opts.okExit ?? [0];
      const argv = [
        ...SAFE_CONFIG.flatMap((c) => ['-c', c]),
        '--no-pager',
        ...(opts.gitDir ? [`--git-dir=${opts.gitDir}`] : []),
        ...args,
      ];
      let child;
      try {
        child = spawn(bin, argv, { cwd: opts.cwd ?? (opts.gitDir && existsSync(opts.gitDir) ? opts.gitDir : tmpdir()), env: buildEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true });
      } catch (err) {
        reject(err instanceof GitError ? err : new GitError('unavailable', `git could not be started: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      const out: Buffer[] = [];
      let outBytes = 0;
      let truncated = false;
      let stderr = '';
      let failure: GitError | null = null;
      let settled = false;
      // The process leads its own group, so a helper it started dies with it (an inherited pipe would keep `close` from firing).
      const killGroup = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const kill = (error: GitError): void => {
        if (failure) return;
        failure = error;
        killGroup();
      };
      const timer = setTimeout(() => kill(new GitError('timeout', `git ${args[0] ?? ''} timed out after ${timeoutMs} ms`)), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        if (outBytes + chunk.length > maxOut) {
          if (opts.onOverflow === 'truncate') {
            out.push(chunk.subarray(0, maxOut - outBytes));
            outBytes = maxOut;
            truncated = true;
            killGroup();
            return;
          }
          kill(new GitError('output_too_large', `git ${args[0] ?? ''} wrote more than ${maxOut} bytes`));
          return;
        }
        out.push(chunk);
        outBytes += chunk.length;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8', 0, Math.min(chunk.length, STDERR_CAP - stderr.length));
      });
      child.stdin.on('error', () => undefined); // the process may exit before reading its input
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new GitError('unavailable', `git could not be started: ${err.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure) return reject(failure);
        const exitCode = code ?? -1;
        if (!truncated && !okExit.includes(exitCode)) {
          const refConflict = /cannot lock ref|but expected|reference already exists|is at [0-9a-f]+ but/.test(stderr);
          return reject(
            new GitError(refConflict ? 'ref_conflict' : 'failed', `git ${args[0] ?? ''} failed (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`, exitCode, stderr),
          );
        }
        resolve({ stdout: Buffer.concat(out), stderr, exitCode, truncated });
      });
      if (opts.input !== undefined) child.stdin.end(typeof opts.input === 'string' ? Buffer.from(opts.input) : Buffer.from(opts.input));
      else child.stdin.end();
    });

  return {
    bin,
    async run(args, opts = {}) {
      const key = opts.gitDir ?? '';
      await acquire(key);
      try {
        return await spawnOnce(args, opts);
      } finally {
        release(key);
      }
    },
    stats: () => ({ running, waiting: waiting.length }),
  };
}
