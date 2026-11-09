import type { ProviderImpl } from './types.ts';

// The `claude.pods` provider (registered by `claude-pods`, extension point `provider.claude.pods`; PLAN P19-05, P19-08): where each Claude Code runner's pod
// stands, and the admin's word that a pod's volumes may be recreated on another machine. `bot-runners` asks it for the admin page; it never talks to the cluster
// itself. Look it up when you need it, not in `register`. When the chart has not turned Claude pods on, it is absent and the page says so.

/** Which command-line tool a runner's pod runs: `claude` (Claude Code, kind `claude_cli`) or `codex` (Codex, kind `codex_cli`). A call that names none means `claude`. */
export type PodAgent = 'claude' | 'codex';

/** Where one Claude Code or Codex runner's pod stands. One runner is one pod. */
export interface ClaudePodPlacement {
  runnerId: string;
  /** `running`: the pod runs. `pending`: it exists and is not placed or not started. `absent`: scaled to zero or not created yet. */
  phase: 'running' | 'pending' | 'absent';
  /** The machine the pod runs or waits on (null while it has none). */
  node: string | null;
  /** The machine the runner's work volume lives on (null when it has none yet or it is not tied to a machine). */
  volumeNode: string | null;
  /** The controller is recreating the volumes on another machine right now. */
  moving: boolean;
  /** The wanted machine differs from the volumes' machine and nobody has confirmed the move: nothing is stopped or deleted. */
  moveHeld: boolean;
  /** One plain word from the pod's own condition for a pending pod. */
  pendingReason: 'unschedulable' | 'starting' | null;
}

export interface ClaudePodsProvider extends ProviderImpl {
  id: 'claude.pods';
  /** Where the given runners' pods stand (`null`: every Claude runner). Rejects when the cluster cannot be asked. */
  podPlacements(query: { runnerIds: readonly string[] | null }): Promise<ClaudePodPlacement[]>;
  /**
   * The admin confirmed that the runner's pod may move to `node`: its work and state volumes are deleted and recreated empty there (the sign-in Secret is kept). Writes a time-limited
   * mark on the volume claims; `node: null` clears it. Returns how many claims were marked or cleared. Rejects when the cluster cannot be asked.
   */
  confirmMove(input: { runnerId: string; node: string | null }): Promise<number>;
  /**
   * Store the runner's sign-in file in its Secret (`claude-<runner>-credentials`, key `.credentials.json`; for `agent: 'codex'`: `codex-<runner>-credentials`, key `auth.json`): the bytes exactly as given. `uploadId` is a fresh random string the pod's
   * start-up step compares with its own copy to know the file was replaced. The bytes are never logged. Rejects when the cluster cannot be asked.
   */
  putCredentials(input: { runnerName: string; runnerId: string; bytes: Uint8Array; uploadId: string; agent?: PodAgent }): Promise<void>;
  /** Remove the runner's sign-in Secret (the pod is stopped by the next pass). Rejects when the cluster cannot be asked. */
  removeCredentials(input: { runnerName: string; agent?: PodAgent }): Promise<void>;
  /** Where the runner's bridge answers and the key it wants, or null when the runner has no pod object yet. The key never leaves the server. */
  bridge(input: { runnerName: string; agent?: PodAgent }): Promise<{ address: string; key: string } | null>;
  /** Ask the pod's bridge whether the saved sign-in still works; `unreachable` when the pod is not running. */
  checkSignin(input: { runnerName: string; agent?: PodAgent }): Promise<'ok' | 'rejected' | 'expired' | 'no_scope' | 'limit' | 'unreachable'>;
}
