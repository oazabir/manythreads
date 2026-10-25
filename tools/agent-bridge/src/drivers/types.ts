import type { BridgeConfig, ProfileConfig } from '../config.ts';
import type { ChildHandle, SpawnOptions } from '../process.ts';
import type { RunRequest } from '../request.ts';
import type { SessionStore } from '../sessions.ts';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export type DriverResult = { ok: true; output: string; usage: Usage | null } | { ok: false; error: string };

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
}

export interface Driver {
  run(job: DriverJob): Promise<DriverResult>;
}
