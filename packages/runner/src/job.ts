import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { childEnv, hermesChatArgs, isProfileHomeFor, removeProfileDir, startGroupProcess, writeProfile, type GroupProcess } from '@manythreads/sdk/process';
import { splitRunnerLine, type RunnerJobFrame, type RunnerToServer } from '@manythreads/shared';
import { profilesDir, type RunnerConfig } from './config.ts';
import { checkServerConfig, RUN_LABEL, withRunnerPolicy } from './policy.ts';

// Running one job (SPEC §7.4, PLAN P6-06): the same steps the server's own Hermes provider takes for a local run — write the profile owner-only,
// start the agent as the leader of a process group, relay its stdout, stop the whole group on a stop or a timeout, remove the profile once nothing
// of the run is left in it — plus what only a machine of its own does: append the runner's policy, run in the team's workspace, remove the
// sandbox container the agent leaves behind.

/** A team slug is a path segment on this machine: only these shapes become a directory. */
const TEAM_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface JobRunnerDeps {
  config: RunnerConfig;
  send(frame: RunnerToServer): void;
  log(line: string): void;
  /** Removes the sandbox containers a run started; replaceable in tests. */
  removeContainers?(runId: string): Promise<void>;
  /** The environment the agent may inherit from (the allowlist is applied on top); the runner's own environment by default. */
  env?: NodeJS.ProcessEnv;
  spawn?: Parameters<typeof startGroupProcess>[0]['spawn'];
  uid?: number | null;
}

export interface JobRunner {
  /** Start a job for `teamSlug`. Never throws: any failure is reported as the job's `exit` frame. */
  start(frame: RunnerJobFrame, teamSlug: string): void;
  stop(jobId: string): void;
  /** Stop every job (the connection is gone, or the runner is shutting down) and wait until they have all been cleaned up. */
  stopAll(): Promise<void>;
  readonly running: number;
}

export function removeSandboxContainers(runId: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('docker', ['ps', '-aq', '--filter', `label=${RUN_LABEL}=${runId}`], { timeout: 15_000 }, (err, out) => {
      const ids = err ? [] : out.split('\n').map((s) => s.trim()).filter((s) => s !== '');
      if (ids.length === 0) return resolve();
      execFile('docker', ['rm', '-f', ...ids], { timeout: 60_000 }, () => resolve());
    });
  });
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const { config, send, log } = deps;
  const jobs = new Map<string, { child: GroupProcess | null; done: Promise<void>; stopRequested: boolean }>();
  const removeContainers = deps.removeContainers ?? (config.terminal === 'docker' ? removeSandboxContainers : async () => undefined);
  const uid = deps.uid !== undefined ? deps.uid : typeof process.getuid === 'function' ? process.getuid() : null;

  interface Ended {
    code: number | null;
    signal: string | null;
    stderrTail: string;
  }
  const refused = (reason: string): Ended => ({ code: null, signal: null, stderrTail: reason });

  /**
   * Run one job to its end and clean up after it; answers how it ended. The `exit` frame is sent by the caller only after this has returned,
   * so the server hears "ended" when the profile (it holds the run's token) and the sandbox containers are already gone.
   */
  async function execute(frame: RunnerJobFrame, teamSlug: string, entry: { child: GroupProcess | null; stopRequested: boolean }): Promise<Ended> {
    let dir = '';
    try {
      if (!TEAM_SLUG.test(teamSlug)) return refused(`refused: "${teamSlug}" is not a team slug this runner will make a directory for`);
      // The profile directory is named by the server, so it is held to the one shape a run's profile has — `<bot slug>-<run id>` — and must be
      // new: an existing Hermes profile (`default`, a person's own) is never overwritten, and never deleted when this job ends.
      if (!isProfileHomeFor(frame.profile.home, frame.runId)) return refused(`refused: "${frame.profile.home}" is not the profile name of run ${frame.runId}`);
      if (existsSync(join(profilesDir(config), frame.profile.home))) return refused(`refused: a profile named "${frame.profile.home}" already exists here`);
      const files = frame.profile.files;
      const check = checkServerConfig(files['config.yaml'] ?? '');
      if (!check.ok) return refused(`refused: ${check.reason}`);

      // The team's workspace: one persistent directory per team, shared by that team's bots, so the coder, the tester and the reviewer see
      // the same checkout. It is the process directory, which the sandbox mounts at /workspace.
      const workspace = join(config.workspaceRoot, teamSlug);
      await mkdir(workspace, { recursive: true, mode: 0o750 });
      const budget = frame.runBudgetSeconds ?? 600;
      dir = await writeProfile(profilesDir(config), frame.profile.home, withRunnerPolicy(files, config, frame.runId, budget, uid));
      if (entry.stopRequested) return { code: null, signal: 'SIGTERM', stderrTail: 'stopped before it started' };

      const child = startGroupProcess({
        ...(deps.spawn ? { spawn: deps.spawn } : {}),
        bin: config.hermesBin,
        args: hermesChatArgs({ runBudgetSeconds: frame.runBudgetSeconds, maxTurns: frame.maxTurns }),
        cwd: workspace,
        env: { ...childEnv(deps.env ?? process.env), HERMES_HOME: dir },
        stdin: frame.prompt,
        killGraceSeconds: frame.killGraceSeconds,
        budgetSeconds: budget,
        onCeiling: (seconds) => log(`job ${frame.jobId} exceeded ${seconds}s and was stopped`),
      });
      entry.child = child;
      if (entry.stopRequested) void child.kill();

      const lines = child.lines;
      if (lines) {
        for (let next = await lines.next(); next.done !== true; next = await lines.next()) {
          for (const piece of splitRunnerLine(next.value, frame.jobId)) send(piece);
        }
      }
      const ended = await child.exited;
      await child.kill(); // anything the agent left in the group goes with it
      await child.settle();
      return { code: ended.code, signal: ended.signal, stderrTail: child.stderrTail() };
    } catch (err) {
      return refused(`the runner could not run the job: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (dir !== '' && !(await removeProfileDir(dir))) log(`the profile of job ${frame.jobId} could not be removed`);
      await removeContainers(frame.runId).catch(() => undefined);
    }
  }

  return {
    start(frame, teamSlug) {
      const reply = (ended: Ended): void => send({ type: 'exit', jobId: frame.jobId, code: ended.code, signal: ended.signal, stderrTail: ended.stderrTail.slice(-2000) });
      if (jobs.size >= config.maxJobs) return reply(refused(`refused: this runner is already running ${jobs.size} job(s), its limit`));
      if (jobs.has(frame.jobId)) return reply(refused('refused: that job is already running here'));
      const entry = { child: null as GroupProcess | null, done: Promise.resolve(), stopRequested: false };
      jobs.set(frame.jobId, entry);
      entry.done = execute(frame, teamSlug, entry).then((ended) => {
        jobs.delete(frame.jobId); // the slot is free before the server hears the job ended
        reply(ended);
      });
    },
    stop(jobId) {
      const entry = jobs.get(jobId);
      if (!entry) return;
      entry.stopRequested = true;
      void entry.child?.kill();
    },
    async stopAll() {
      const all = [...jobs.values()];
      for (const entry of all) {
        entry.stopRequested = true;
        void entry.child?.kill();
      }
      await Promise.all(all.map((entry) => entry.done));
    },
    get running() {
      return jobs.size;
    },
  };
}
