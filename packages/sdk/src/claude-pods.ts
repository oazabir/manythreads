import type { ProviderImpl } from './types.ts';

// The `claude.pods` provider (registered by `claude-pods`, extension point `provider.claude.pods`; PLAN P19-05, P19-08, P26-21): where each Claude Code runner's pods
// stands, and the admin's word that a pod's volumes may be recreated on another machine. `bot-runners` asks it for the admin page; it never talks to the cluster
// itself. Look it up when you need it, not in `register`. When the chart has not turned Claude pods on, it is absent and the page says so.

/** Which command-line tool a runner's pod runs: `claude` (Claude Code, kind `claude_cli`) or `codex` (Codex, kind `codex_cli`). A call that names none means `claude`. */
export type PodAgent = 'claude' | 'codex';

/**
 * Where one Claude Code or Codex runner's pods stand, as one answer: a runner has one pod per team (P26-21), and the answer says the worst of them (one pending pod makes the runner pending) and
 * the machine of the pod that runs.
 */
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
  /**
   * Where a pod of the runner answers and the key it wants, or null when there is no such pod yet. The key never leaves the server.
   * `teamSlug` names the team: a run goes to the pod of its own team and no other, and on a runner where each team signs in (P35-10) the team's own sign-in is that pod's. Without it (the sign-in of the runner, which lives in the state volume all the runner's pods share) any one live pod
   * of the runner answers: the first by name that is running, so that the steps of one sign-in meet the same pod.
   */
  bridge(input: { runnerName: string; agent?: PodAgent; teamSlug?: string }): Promise<{ address: string; key: string } | null>;
  /** Ask a pod's bridge whether the saved sign-in still works; `unreachable` when no pod is running. `teamSlug`: that team's pod (a runner where each team signs in). */
  checkSignin(input: { runnerName: string; agent?: PodAgent; teamSlug?: string }): Promise<'ok' | 'rejected' | 'expired' | 'no_scope' | 'limit' | 'unreachable'>;
  /**
   * Delete the team sign-in volumes of a runner where each team signs in (P35-10): every claim `<team pod>-signin` that carries the runner's id, or only the one of `teamId`. The pods
   * that mount them are restarted by the controller's next pass. Returns how many were deleted. Rejects when the cluster cannot be asked.
   */
  removeTeamSignins(input: { runnerId: string; teamId?: string }): Promise<number>;
}
