import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServerProfileName, profileFor, serverSigninScope, serverSigninUnreadable, type BridgeConfig } from './config.ts';
import { prepareServerRun, type ServerRunSupport } from './server-run.ts';
import { ensureTeamUser, hasTeamUsers, TeamRun, teamSigninFacts } from './server-team.ts';
import { acpDriver } from './drivers/acp.ts';
import { flavorOf } from './acp/adapter.ts';
import { NO_TEAM_USERS_FULL_ACCESS } from './full-access.ts';
import { claudeCodeDriver } from './drivers/claude-code.ts';
import { codexDriver } from './drivers/codex.ts';
import type { Driver, DriverJob } from './drivers/types.ts';
import { startChild, type ChildHandle } from './process.ts';
import type { RunRequest } from './request.ts';
import { KeyedQueue, type SessionStore } from './sessions.ts';
import { classifyFailure, FACTS_UNKNOWN, limitResetsAt, SigninGate, type FileFacts } from './signin.ts';
import { teamSigninDir } from './team-user.ts';

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
  /**
   * A server where each team signs in (P35-10b): the team's sign-in state as last seen (`AuthService.knownState`). A team that is signed out is refused at once with a plain sentence;
   * `unknown` lets the run go (it finds out itself).
   */
  teamSignin?: (agent: 'claude' | 'codex', team: string) => Promise<'signed_in' | 'signed_out' | 'unknown' | 'not_needed'>;
  /** Test hook: what a team's own sign-in file says about its dates (default: the helper's `signin-facts`, as the team user). Null: unknown. */
  teamFacts?: (agent: 'claude' | 'codex', team: string) => Promise<{ exists: boolean; valid: boolean; expiresAt: number | null; refreshedAt: number | null; mtimeMs: number | null } | null>;
  log: (line: string) => void;
}

/** The refusal of a run of a team that has not signed in on a server where each team signs in (docs/plans/per-team-sign-in.md section 1; the site says the same with the team's name). */
export const teamNotSignedInHere = (team: string, agent: 'claude' | 'codex'): string =>
  `Team ${team} has not signed in to ${agent === 'codex' ? 'Codex' : 'Claude Code'} on this server yet. An admin can sign it in on the Runners page.`;

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
  /** One gate per team sign-in folder (P35-10b): a refused sign-in or a plan limit of one team holds only that team's runs. */
  private readonly teamGates = new Map<string, SigninGate>();
  private teamSigninOf: RunManagerOptions['teamSignin'] | undefined;

  /** What a run of a team that signs in on its own asks first (set by the HTTP face once its sign-in service exists). */
  setTeamSignin(fn: NonNullable<RunManagerOptions['teamSignin']>): void {
    this.teamSigninOf = fn;
  }
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

  /**
   * Stops every live run of one agent (P31-01b): after its sign-in was removed, a run that holds a copy of it must not go on with it. Returns how many were
   * asked to stop.
   */
  stopAgent(flavor: 'claude' | 'codex', reason: string): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      const target = profileFor(this.opts.config, run.profile);
      if (!target || flavorOf(target.profile.agent) !== flavor) continue;
      this.stop(run, reason);
      n += 1;
    }
    return n;
  }

  /** Stops every live run of one team on one agent (its own sign-in was signed out). Returns how many were asked to stop. */
  stopTeamAgent(flavor: 'claude' | 'codex', team: string, reason: string): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.status !== 'running') continue;
      const who = parseServerProfileName(run.profile);
      if (who === null || who.team !== team || who.agentKey !== flavor) continue;
      this.stop(run, reason);
      n += 1;
    }
    return n;
  }

  /**
   * The gate of a team's own sign-in folder (P35-10b). The folder is the team user's (0700), so the bridge cannot read the file: the gate learns its dates from the helper
   * (`signin-facts`, as the team user, at most every 30 s and again after a run that may have renewed). Facts it cannot learn count as "a renewal is near": that team's runs then go
   * one at a time, so two runs of one team never both renew. `forgetTeamGate` drops its remembered refusal (after a sign-in or a sign-out of that folder).
   */
  teamGate(agent: 'claude-code' | 'codex', folder: string, team?: string): SigninGate {
    const key = `${agent}|${folder}`;
    let gate = this.teamGates.get(key);
    if (gate !== undefined) return gate;
    const which = agent === 'codex' ? 'codex' : 'claude';
    const server = this.opts.config.server;
    const ask = this.opts.teamFacts ?? (hasTeamUsers(server) ? (a: 'claude' | 'codex', t: string) => teamSigninFacts(server, t, a) : undefined);
    let known: { at: number; facts: FileFacts } | null = null;
    const source =
      team === undefined || ask === undefined
        ? undefined
        : {
            facts: () => known?.facts ?? FACTS_UNKNOWN,
            refresh: async (force: boolean) => {
              if (!force && known !== null && Date.now() - known.at < 30_000) return;
              const f = await ask(which, team).catch(() => null);
              known = { at: Date.now(), facts: f === null ? FACTS_UNKNOWN : { exists: f.exists, valid: f.valid, scopeOk: f.valid, expiresAt: f.expiresAt, refreshedAt: f.refreshedAt, mtimeMs: f.mtimeMs } };
            },
          };
    gate = new SigninGate(folder, Date.now, agent, source);
    this.teamGates.set(key, gate);
    return gate;
  }

  forgetTeamGate(agent: 'claude-code' | 'codex', folder: string): void {
    this.teamGates.delete(`${agent}|${folder}`);
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
    /** The team's own sign-in folder, on a server where each team signs in (its gate is that folder's). */
    let ownSignin: string | null = null;
    let ownTeam: string | undefined;
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
          if ((who.agentKey === 'claude' || who.agentKey === 'codex') && serverSigninUnreadable(config)) {
            const error = `This server could not read who signs in to ${who.agentKey === 'codex' ? 'Codex' : 'Claude Code'}. An admin can choose Who signs in again on the Runners page.`;
            run.error = error;
            this.finish(run, 'failed', 'run.failed', { error });
            return;
          }
          const ownScope = (who.agentKey === 'claude' || who.agentKey === 'codex') && serverSigninScope(config, who.agentKey) === 'per_team';
          team = new TeamRun(config.server, who.team, AGENT_KIND[who.agentKey], ownScope ? 'per_team' : undefined);
          // P35-10b: each team signs in on its own: a team that has not is refused at once, never run on another sign-in
          if (ownScope && (who.agentKey === 'claude' || who.agentKey === 'codex')) {
            ownSignin = teamSigninDir(config.server.root, who.team, who.agentKey);
            ownTeam = who.team;
            const state = (await (this.teamSigninOf ?? this.opts.teamSignin)?.(who.agentKey, who.team).catch(() => 'unknown' as const)) ?? 'unknown';
            if (state === 'signed_out') {
              const error = teamNotSignedInHere(who.team, who.agentKey);
              run.error = error;
              this.finish(run, 'failed', 'run.failed', { error, reason: 'needs_sign_in' });
              return;
            }
          }
        }
        // an enrolled server: this run's copy of the profile (where-you-run text, tools, kubeconfig, Hermes home), made with the run's own token
        profile = await prepareServerRun(config, profileName, baseProfile, given, { ...this.opts.serverRun, log: (line) => this.opts.log(`run ${run.id} ${line}`), onEnd: (fn) => cleanups.push(fn), ...(team !== null ? { team } : {}) });
        request = withProfileInstructions(given, profile.instructions);
        // A server without team users runs every team as the bridge's one user: it never gets full access (P35-01), and the thread says why commands still ask.
        if (!hasTeamUsers(config.server) && profile.fullAccess !== undefined && profile.fullAccess !== false) {
          profile = { ...profile, fullAccess: false };
          if (given.manythreads.fullAccess === true && run.status === 'running') run.emit('message.delta', { delta: `${NO_TEAM_USERS_FULL_ACCESS}\n\n` });
        }
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
      const gate =
        ownSignin !== null && (profile.agent === 'claude-code' || profile.agent === 'codex')
          ? this.teamGate(profile.agent, ownSignin, ownTeam)
          : profile.agent === 'claude-code'
            ? this.opts.gate
            : profile.agent === 'codex'
              ? this.opts.codexGate
              : undefined;
      const standing = gate?.standing() ?? null;
      if (standing !== null) {
        // A refused sign-in or a plan limit is already known: no process is started and nothing is retried.
        const who = profile.agent === 'codex' ? { name: 'Codex', plan: 'ChatGPT plan' } : { name: 'Claude', plan: 'Claude plan' };
        const refused = ownSignin !== null ? `This team's own ${who.name} sign-in was refused. An admin can sign the team in again on the Runners page.` : `The ${who.name} sign-in was refused. An admin has to upload a new sign-in file.`;
        const error = standing.kind === 'needs_sign_in' ? refused : `The ${who.plan}'s limit was reached.`;
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
