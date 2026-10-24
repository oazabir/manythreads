import type { ProviderImpl } from './types.ts';

// The `provider.runner` contract (SPEC §7.4; PLAN P6-06). A runner is one program on a machine outside the cluster that holds one outbound
// connection to the server and runs agent processes for one team. The runners plugin owns the connections and registers this door;
// `runtime-hermes` asks it to run a bot whose `placement.runner` names a runner, and gets back the same two things a local child gives it —
// the process's stdout lines and its exit — so the run's events, result and failures are read by one code path whether the agent runs in
// the server's pod or on a runner.

/** Everything a runner needs to run one turn of a bot: the profile to write, the prompt (sent as data, never as an argument) and the budgets. */
export interface RunnerJob {
  runId: string;
  /** The profile home's name and files (`config.yaml`, `SOUL.md`), exactly as the server rendered them. */
  profile: { home: string; files: Record<string, string> };
  prompt: string;
  runBudgetSeconds: number | null;
  maxTurns: number | null;
  /** Between SIGTERM and SIGKILL when the run is stopped. */
  killGraceSeconds: number;
}

/** How the process ended, as the runner saw it. `stderrTail` is the last few lines it printed, for the failure a silent death reports. */
export interface RunnerProcessExit {
  code: number | null;
  signal: string | null;
  stderrTail: string;
}

/** A job running on a runner. `lines` ends when the process's stdout does; `exited` settles once, after the runner reports the exit. */
export interface RunnerDispatch {
  lines: AsyncIterable<string>;
  exited: Promise<RunnerProcessExit>;
  /** Tell the runner to stop the process (its whole process group). Idempotent; resolves once the request is sent. */
  stop(): Promise<void>;
}

/** Why a job could not be sent: the runner is unknown, not connected to this replica, full, or went away. `reason` is a sentence for the run's log. */
export class RunnerUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'RunnerUnavailableError';
    this.reason = reason;
  }
}

export interface RunnerDoor extends ProviderImpl {
  id: string;
  /**
   * Send a job to the runner called `runner` of team `teamId`. Fails fast with `RunnerUnavailableError` when that runner is not connected to
   * this server process right now (with several server replicas a runner is connected to one of them; see docs/plugins/runners.md), when it
   * has no free slot, or when the connection drops before the job is accepted. A connection that drops later ends the job like a killed
   * process: `exited` settles with a null code and a signal naming the loss.
   */
  dispatch(input: { teamId: string; runner: string; job: RunnerJob }): Promise<RunnerDispatch>;
}
