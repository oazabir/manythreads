import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServerProfileName, profileFor, type BridgeConfig } from './config.ts';
import { prepareServerRun, type ServerRunSupport } from './server-run.ts';
import { ensureTeamUser, hasTeamUsers, TeamRun } from './server-team.ts';
import { acpDriver } from './drivers/acp.ts';
import { claudeCodeDriver } from './drivers/claude-code.ts';
import { codexDriver } from './drivers/codex.ts';
import type { Driver, DriverJob } from './drivers/types.ts';
import { startChild, type ChildHandle } from './process.ts';
import type { RunRequest } from './request.ts';
import { KeyedQueue, type SessionStore } from './sessions.ts';
import { classifyFailure, limitResetsAt, type SigninGate } from './signin.ts';

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
  /** Set by a driver that ends gracefully (ACP): called on a stop instead of an immediate SIGTERM. */
  stopHandler: { run: () => void; graceSeconds: number } | null = null;
  approvalHandler: ((requestId: string | null, choice: string) => boolean) | null = null;
  steerHandler: ((text: string) => Promise<boolean>) | null = null;

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
  /** The Claude sign-in gate (claude-code profiles only): one renewing process, and the account failures remembered. */
  gate?: SigninGate;
  /** The same for Codex (codex profiles only; its `auth.json`). */
  codexGate?: SigninGate;
  /** Test hook: replaces the drivers by agent name. */
  drivers?: Record<string, Driver>;
  /** An enrolled server: the site's address, from which each run's profile is made (server-run.ts). Absent for every other bridge. */
  serverRun?: Omit<ServerRunSupport, 'log'>;
  log: (line: string) => void;
}

/** What the helper starts for a server-mode agent key. */
const AGENT_KIND = { claude: 'claude', codex: 'codex', hermes: 'hermes' } as const;

const drivers: Record<string, Driver> = { 'claude-code': claudeCodeDriver, codex: codexDriver, acp: acpDriver };

// What a child may inherit from the bridge's own environment. Everything else (GITHUB_TOKEN, cloud keys, ...) stays behind.
const ENV_COMMON = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TERM|TMPDIR|TZ|XDG_[A-Z_]+|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/;
const ENV_BY_AGENT: Record<string, RegExp> = {
  'claude-code': /^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)$/,
  codex: /^(CODEX_HOME|OPENAI_API_KEY)$/,
  'hermes-acp': /^(HERMES_HOME)$/,
  opencode: /^(OPENCODE_[A-Z_]+)$/,
};

/** The variable that tells a tool where its own sign-in lives; null for a tool without a sign-in of its own. */
export const authHomeVariable = (agent: string): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | null => (agent === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : agent === 'codex' ? 'CODEX_HOME' : null);

/**
 * The environment a child starts with: the allowlist above, the profile's `passEnv` names, then the profile's `env` values. In a pod (`MANYTHREADS_BRIDGE_IN_POD=1`) a Codex child
 * never gets `OPENAI_API_KEY`, however it was asked for: an API key would go around the workspace's model gateway (PLAN P19-13).
 */
export function childEnv(profile: BridgeConfig['profiles'][string], from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const own = ENV_BY_AGENT[profile.agent];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (ENV_COMMON.test(k) || own?.test(k) === true || profile.passEnv?.includes(k) === true) env[k] = v;
  }
  // A profile with its own sign-in home (`authHome`) gets the tool's variable for it, unless its `env` names one explicitly.
  const homeVar = authHomeVariable(profile.agent);
  if (profile.authHome !== undefined && homeVar !== null) env[homeVar] = profile.authHome;
  for (const [k, v] of Object.entries(profile.env ?? {})) env[k] = v;
  if (profile.agent === 'codex' && from['MANYTHREADS_BRIDGE_IN_POD'] === '1') delete env['OPENAI_API_KEY'];
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
    const already = run.stopRequested;
    run.stopRequested = true;
    if (reason !== null) run.failReason ??= reason;
    if (run.stopHandler !== null) {
      // A graceful driver (ACP) cancels the turn itself and ends its process; the kill comes only if it has not finished after its grace.
      // A second stop changes nothing: it must not push the kill back.
      if (!already) {
        run.stopHandler.run();
        this.armKill(run, run.stopHandler.graceSeconds);
      }
      return;
    }
    for (const c of run.children) c.signal('SIGTERM');
    if (!already) this.armKill(run);
  }

  private armKill(run: Run, extraSeconds = 0): void {
    clearTimeout(run.killTimer);
    run.killTimer = setTimeout(() => {
      for (const c of run.children) c.signal('SIGKILL');
    }, (this.opts.config.killGraceSeconds + extraSeconds) * 1000);
    run.killTimer.unref();
  }

  private finish(run: Run, status: RunStatus, event: string, fields: Record<string, unknown>): void {
    if (run.status !== 'running') return;
    run.status = status;
    run.finishedAt = Date.now();
    clearTimeout(run.killTimer);
    run.emit(event, fields);
  }

  private async drive(run: Run, profileName: string, baseProfile: BridgeConfig['profiles'][string], given: RunRequest): Promise<void> {
    const { config } = this.opts;
    let profile = baseProfile;
    let request = withProfileInstructions(given, profile.instructions);
    const started = Date.now();
    const budgetS = request.manythreads.budgetSeconds ?? config.defaultBudgetSeconds;
    let budgetTimer: NodeJS.Timeout | undefined;
    let budgetEndsAt = 0;
    let holds = 0;
    /** What was left of the budget when the first of the overlapping questions began, and at least a minute: the clock starts again with that when the last is answered. */
    let heldLeft = 0;
    const armBudget = (ms: number): void => {
      clearTimeout(budgetTimer);
      budgetEndsAt = Date.now() + ms;
      budgetTimer = setTimeout(() => this.stop(run, 'budget exceeded'), ms);
      budgetTimer.unref();
    };
    let runDir: string | null = null;
    /** Set when this run is a team's on a server with team users: its programs are started through the helper. */
    let team: TeamRun | null = null;
    /** What the run left on this machine that must go with it (the deployer's kubeconfig). */
    const cleanups: Array<() => void> = [];
    try {
      if (run.stopRequested) {
        this.finish(run, 'cancelled', 'run.cancelled', {});
        return;
      }
      if (this.opts.serverRun !== undefined) {
        const who = hasTeamUsers(config.server) ? parseServerProfileName(profileName) : null;
        if (who !== null && hasTeamUsers(config.server)) {
          // P26-22: this team's runs are started as the team's own user, through the root helper; its user is made now (the first run of a team), so a refusal is the run's plain failure
          await ensureTeamUser(config.server.teamUsers, who.team);
          team = new TeamRun(config.server, who.team, AGENT_KIND[who.agentKey]);
        }
        // an enrolled server: this run's copy of the profile (where-you-run text, tools, kubeconfig, Hermes home), made with the run's own token
        profile = await prepareServerRun(config, profileName, baseProfile, given, { ...this.opts.serverRun, log: (line) => this.opts.log(`run ${run.id} ${line}`), onEnd: (fn) => cleanups.push(fn), ...(team !== null ? { team } : {}) });
        request = withProfileInstructions(given, profile.instructions);
      }
      if (run.stopRequested) {
        this.finish(run, 'cancelled', 'run.cancelled', {});
        return;
      }
      // a team's folders belong to the team's user: the helper makes the working folder
      if (team === null) mkdirSync(profile.workdir, { recursive: true });
      runDir = mkdtempSync(join(this.opts.tmpRoot ?? tmpdir(), 'agent-bridge-run-'));
      armBudget((budgetS + config.budgetGraceSeconds) * 1000);

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
        log: (line) => this.opts.log(`run ${run.id} ${line}`),
        start: (bin, args, o) => {
          const child = team !== null ? team.start(o) : startChild(bin, args, o);
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
        onStop: (handler, graceSeconds) => {
          run.stopHandler = { run: handler, graceSeconds };
        },
        onApproval: (handler) => {
          run.approvalHandler = handler;
        },
        onSteer: (handler) => {
          run.steerHandler = handler;
        },
        budgetLeftMs: () => (holds > 0 ? heldLeft : Math.max(0, budgetEndsAt - Date.now())),
        holdBudget: () => {
          // What was left of the budget when the run stopped to ask, and at least a minute again: the answer does not eat the time the work needs.
          // Taken once, when the first question begins: a second question that overlaps the first would read a clock that is no longer running.
          if (holds === 0) heldLeft = Math.max(60_000, budgetEndsAt - Date.now());
          holds += 1;
          clearTimeout(budgetTimer);
          let released = false;
          return () => {
            if (released) return;
            released = true;
            holds -= 1;
            if (holds === 0 && run.status === 'running') armBudget(heldLeft);
          };
        },
      };
      const gate = profile.agent === 'claude-code' ? this.opts.gate : profile.agent === 'codex' ? this.opts.codexGate : undefined;
      const standing = gate?.standing() ?? null;
      if (standing !== null) {
        // A refused sign-in or a plan limit is already known: no process is started and nothing is retried.
        const who = profile.agent === 'codex' ? { name: 'Codex', plan: 'ChatGPT plan' } : { name: 'Claude', plan: 'Claude plan' };
        const error = standing.kind === 'needs_sign_in' ? `The ${who.name} sign-in was refused. An admin has to upload a new sign-in file.` : `The ${who.plan}'s limit was reached.`;
        this.finish(run, 'failed', 'run.failed', { error, reason: standing.kind, ...(standing.until !== null ? { resets_at: standing.until } : {}) });
        return;
      }
      const driver = (this.opts.drivers ?? drivers)[profile.driver === 'acp' ? 'acp' : profile.agent]!;
      const result = gate ? await gate.run(() => driver.run(job)) : await driver.run(job);
      if (run.stopRequested) {
        if (run.failReason !== null) {
          run.error = run.failReason;
          this.finish(run, 'failed', 'run.failed', { error: run.failReason });
        } else this.finish(run, 'cancelled', 'run.cancelled', {});
      } else if (result.ok) {
        run.output = result.output;
        run.usage = result.usage;
        this.finish(run, 'completed', 'run.completed', { output: result.output, usage: result.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, ...(result.extra ?? {}) });
      } else {
        run.error = result.error;
        const account = gate && (profile.agent === 'claude-code' || profile.agent === 'codex') ? classifyFailure(result.error, profile.agent, profile.driver) : null;
        if (account !== null) gate!.noteFailure(account, result.error);
        const resets = account === 'plan_limit' ? limitResetsAt(result.error) : null;
        this.finish(run, 'failed', 'run.failed', { error: result.error, ...(result.extra ?? {}), ...(account !== null ? { reason: account } : {}), ...(resets !== null ? { resets_at: resets } : {}) });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      run.error = msg.slice(0, 300);
      this.finish(run, 'failed', 'run.failed', { error: run.error });
    } finally {
      clearTimeout(budgetTimer);
      if (runDir !== null) rmSync(runDir, { recursive: true, force: true });
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          this.opts.log(`run ${run.id} could not remove a file the run made`);
        }
      }
      // No prompt, no token, no output text: only what a person debugging needs.
      this.opts.log(
        `run ${run.id} profile=${profileName} agent=${profile.agent} status=${run.status} seconds=${Math.round((Date.now() - started) / 100) / 10} events=${run.nextSeq}`,
      );
    }
  }
}

/** The bot's BOT.md (sent by the server) first, then the profile's own note about this machine. */
export function withProfileInstructions(request: RunRequest, note: string | undefined): RunRequest {
  if (note === undefined || note.trim() === '') return request;
  const own = `## Where you run\n\n${note.trim()}`;
  return { ...request, instructions: request.instructions === null ? own : `${request.instructions.trimEnd()}\n\n${own}` };
}
