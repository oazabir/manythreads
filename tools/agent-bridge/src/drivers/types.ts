import type { BridgeConfig, ProfileConfig } from '../config.ts';
import type { ChildHandle, SpawnOptions } from '../process.ts';
import type { RunRequest } from '../request.ts';
import type { SessionStore } from '../sessions.ts';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** The CLI's own cost figure for the run (`total_cost_usd`), when it gives one. Its number, not a price. */
  cost?: number;
}

/** `extra` is merged into the `run.completed` frame (an ACP run adds `stop_reason`). */
export type DriverResult = { ok: true; output: string; usage: Usage | null; extra?: Record<string, unknown> } | { ok: false; error: string };

/** What a driver is given for one run. */
export interface DriverJob {
  runId: string;
  profileName: string;
  profile: ProfileConfig;
  config: BridgeConfig;
  request: RunRequest;
  /** A private folder (mode 0700) for this run's files; removed when the run ends. */
  runDir: string;
  sessions: SessionStore;
  /** Add an event to the run's stream. */
  emit(event: string, fields?: Record<string, unknown>): void;
  /** Start a process that the bridge can stop (it is killed with its whole group on stop or budget). */
  start(bin: string, args: string[], opts: SpawnOptions): ChildHandle;
  /** True once a stop, a budget kill or a turn limit was requested. */
  stopped(): boolean;
  /** Ask for the run to be killed and failed with this reason. */
  abort(reason: string): void;
  /** The environment a child starts with: an allowlist of the bridge's own plus the profile's `env` and `passEnv`. */
  baseEnv(): NodeJS.ProcessEnv;
  /**
   * A driver that can end its work gracefully (an ACP run: `session/cancel`) registers here. On a stop the bridge calls `handler` instead of SIGTERM at once, and
   * only after `graceSeconds` plus the kill grace does it SIGKILL the children. The driver ends its own process when it is done cancelling.
   */
  onStop(handler: () => void, graceSeconds: number): void;
  /** Answers a person's choice for the permission request `requestId` (`POST /v1/runs/:id/approval`); true when it was waiting. Set once. */
  onApproval(handler: (requestId: string | null, choice: string) => boolean): void;
  /** Passes a person's note to the agent (`POST /v1/runs/:id/steer`); resolves false when the agent cannot take one. Set once. */
  onSteer(handler: (text: string) => Promise<boolean>): void;
  /** The run's clock (its budget) stops while a person decides; call the result when the answer is in and it starts again with what was left (at least 60 s). */
  holdBudget(): () => void;
}

export interface Driver {
  run(job: DriverJob): Promise<DriverResult>;
}
