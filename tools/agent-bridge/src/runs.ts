import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor, type BridgeConfig } from './config.ts';
import { claudeCodeDriver } from './drivers/claude-code.ts';
import { codexDriver } from './drivers/codex.ts';
import type { Driver, DriverJob } from './drivers/types.ts';
import { startChild, type ChildHandle } from './process.ts';
import type { RunRequest } from './request.ts';
import { KeyedQueue, type SessionStore } from './sessions.ts';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Frame {
  seq: number;
  data: Record<string, unknown>;
}

const MAX_FRAMES = 4000;
const MAX_FRAME_BYTES_TOTAL = 16 * 1024 * 1024;
const MAX_FIELD_CHARS = 256 * 1024;

export class Run {
  status: RunStatus = 'running';
  frames: Frame[] = [];
  nextSeq = 0;
  bytes = 0;
  output = '';
  usage: unknown = null;
  error: string | null = null;
  finishedAt: number | null = null;
  readonly subscribers = new Set<() => void>();
  children = new Set<ChildHandle>();
  stopRequested = false;
  failReason: string | null = null;
  killTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly id: string,
    readonly profile: string,
    readonly bodyHash: string,
  ) {}

  emit(event: string, fields: Record<string, unknown> = {}): void {
    const clipped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) clipped[k] = typeof v === 'string' && v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) : v;
    const seq = this.nextSeq++;
    const data = { event, run_id: this.id, seq, timestamp: Date.now() / 1000, ...clipped };
    this.bytes += JSON.stringify(data).length;
    this.frames.push({ seq, data });
    // Bounded memory: the oldest non-terminal frames go first. A reader that fell that far behind resumes from what is left.
    while (this.frames.length > 1 && (this.frames.length > MAX_FRAMES || this.bytes > MAX_FRAME_BYTES_TOTAL)) {
      const dropped = this.frames.shift()!;
      this.bytes -= JSON.stringify(dropped.data).length;
    }
    for (const poke of this.subscribers) poke();
  }

  /** Frames after `lastSeq` (all of them when null). */
  framesAfter(lastSeq: number | null): Frame[] {
    return lastSeq === null ? this.frames : this.frames.filter((f) => f.seq > lastSeq);
  }
}

export class TooManyRuns extends Error {}
export class IdempotencyConflict extends Error {}
export class UnknownProfile extends Error {}

export interface RunManagerOptions {
  config: BridgeConfig;
  sessions: SessionStore;
  /** Where per-run folders are made. Default: the OS temp dir. */
  tmpRoot?: string;
  /** Test hook: replaces the drivers by agent name. */
  drivers?: Record<string, Driver>;
  log: (line: string) => void;
}

const drivers: Record<string, Driver> = { 'claude-code': claudeCodeDriver, codex: codexDriver };

// What a child may inherit from the bridge's own environment. Everything else (GITHUB_TOKEN, cloud keys, ...) stays behind.
const ENV_COMMON = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TERM|TMPDIR|TZ|XDG_[A-Z_]+|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/;
const ENV_BY_AGENT: Record<string, RegExp> = {
  'claude-code': /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/,
  codex: /^(CODEX_HOME|OPENAI_API_KEY)$/,
};

/** The environment a child starts with: the allowlist above, the profile's `passEnv` names, then the profile's `env` values. */
export function childEnv(profile: BridgeConfig['profiles'][string], from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const own = ENV_BY_AGENT[profile.agent];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (ENV_COMMON.test(k) || own?.test(k) === true || profile.passEnv?.includes(k) === true) env[k] = v;
  }
  for (const [k, v] of Object.entries(profile.env ?? {})) env[k] = v;
  return env;
}

export class RunManager {
  private readonly runs = new Map<string, Run>();
  private readonly idem = new Map<string, { runId: string; bodyHash: string }>();
  private readonly queue = new KeyedQueue();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly opts: RunManagerOptions) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const run of this.runs.values()) if (run.status === 'running') this.stop(run, 'bridge shutting down');
  }

  get(profile: string, id: string): Run | undefined {
    const run = this.runs.get(id);
    return run && run.profile === profile ? run : undefined;
  }

  private liveCount(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.status === 'running') n += 1;
    return n;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.opts.config.keepFinishedSeconds * 1000;
    for (const [id, run] of this.runs) {
      if (run.finishedAt !== null && run.finishedAt < cutoff) {
        this.runs.delete(id);
        for (const [k, v] of this.idem) if (v.runId === id) this.idem.delete(k);
      }
    }
  }

  /** Start a run (or answer the one an idempotency key already made). Throws TooManyRuns, IdempotencyConflict, UnknownProfile. */
  create(profile: string, request: RunRequest, rawBody: string, idempotencyKey: string | null): { run: Run; created: boolean } {
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    const scopedKey = idempotencyKey === null ? null : `${profile}\0${idempotencyKey}`;
    if (scopedKey !== null) {
      const seen = this.idem.get(scopedKey);
      const run = seen ? this.runs.get(seen.runId) : undefined;
      if (seen && run) {
        if (seen.bodyHash !== bodyHash) throw new IdempotencyConflict();
        return { run, created: false };
      }
    }
    const target = profileFor(this.opts.config, profile);
    if (!target) throw new UnknownProfile();
    if (this.liveCount() >= this.opts.config.maxConcurrentRuns) throw new TooManyRuns();

    const run = new Run(randomUUID(), profile, bodyHash);
    this.runs.set(run.id, run);
    if (scopedKey !== null) this.idem.set(scopedKey, { runId: run.id, bodyHash });
    const sessionKey = request.sessionId === null ? run.id : `${profile}\0${request.sessionId}`;
    void this.queue.run(sessionKey, () => this.drive(run, target.name, target.profile, request));
    return { run, created: true };
  }

  /** Ask a run to stop: SIGTERM to its process group, SIGKILL after the grace. The run ends as cancelled (or failed with `reason`). */
  stop(run: Run, reason: string | null = null): void {
    if (run.status !== 'running') return;
    run.stopRequested = true;
    if (reason !== null) run.failReason ??= reason;
    for (const c of run.children) c.signal('SIGTERM');
    this.armKill(run);
  }

  private armKill(run: Run): void {
    clearTimeout(run.killTimer);
    run.killTimer = setTimeout(() => {
      for (const c of run.children) c.signal('SIGKILL');
    }, this.opts.config.killGraceSeconds * 1000);
    run.killTimer.unref();
  }

  private finish(run: Run, status: RunStatus, event: string, fields: Record<string, unknown>): void {
    if (run.status !== 'running') return;
    run.status = status;
    run.finishedAt = Date.now();
    clearTimeout(run.killTimer);
    run.emit(event, fields);
  }

  private async drive(run: Run, profileName: string, profile: BridgeConfig['profiles'][string], request: RunRequest): Promise<void> {
    const { config } = this.opts;
    const started = Date.now();
    const budgetS = request.manythreads.budgetSeconds ?? config.defaultBudgetSeconds;
    let budgetTimer: NodeJS.Timeout | undefined;
    let runDir: string | null = null;
    try {
      if (run.stopRequested) {
        this.finish(run, 'cancelled', 'run.cancelled', {});
        return;
      }
      mkdirSync(profile.workdir, { recursive: true });
      runDir = mkdtempSync(join(this.opts.tmpRoot ?? tmpdir(), 'agent-bridge-run-'));
      budgetTimer = setTimeout(() => this.stop(run, 'budget exceeded'), (budgetS + config.budgetGraceSeconds) * 1000);
      budgetTimer.unref();

      const job: DriverJob = {
        runId: run.id,
        profileName,
        profile,
        config,
        request,
        runDir,
        sessions: this.opts.sessions,
        emit: (event, fields) => {
          if (run.status === 'running') run.emit(event, fields);
        },
        start: (bin, args, o) => {
          const child = startChild(bin, args, o);
          run.children.add(child);
          // Whatever a tool left running in the run's process group (a background server, a watcher) ends with the run.
          void child.done.then(() => {
            run.children.delete(child);
            child.signal('SIGKILL');
          });
          if (run.stopRequested) {
            child.signal('SIGTERM');
            this.armKill(run);
          }
          return child;
        },
        stopped: () => run.stopRequested,
        abort: (reason) => this.stop(run, reason),
        baseEnv: () => childEnv(profile),
      };
      const result = await (this.opts.drivers ?? drivers)[profile.agent]!.run(job);
      if (run.stopRequested) {
        if (run.failReason !== null) {
          run.error = run.failReason;
          this.finish(run, 'failed', 'run.failed', { error: run.failReason });
        } else this.finish(run, 'cancelled', 'run.cancelled', {});
      } else if (result.ok) {
        run.output = result.output;
        run.usage = result.usage;
        this.finish(run, 'completed', 'run.completed', { output: result.output, usage: result.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
      } else {
        run.error = result.error;
        this.finish(run, 'failed', 'run.failed', { error: result.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      run.error = msg.slice(0, 300);
      this.finish(run, 'failed', 'run.failed', { error: run.error });
    } finally {
      clearTimeout(budgetTimer);
      if (runDir !== null) rmSync(runDir, { recursive: true, force: true });
      // No prompt, no token, no output text: only what a person debugging needs.
      this.opts.log(
        `run ${run.id} profile=${profileName} agent=${profile.agent} status=${run.status} seconds=${Math.round((Date.now() - started) / 100) / 10} events=${run.nextSeq}`,
      );
    }
  }
}
