import type { ProviderImpl } from './types.ts';

// The `runner.nodes` provider (registered by `hermes-pods`, extension point `provider.runner.nodes`; PLAN P19-08): the cluster's machines ("nodes") and where
// the team Hermes pods stand on them. `bot-runners` asks it for the admin's node picker and to check a chosen node. It is the node-lister: the real one
// reads the Kubernetes API, a test supplies a fake. Look it up when you need it, not in `register`.
//
//   ctx.providers.get<RunnerNodesProvider>('runner.nodes')?.listNodes()
//
// Nothing here is a secret, but the names of the machines are shown to workspace admins only.

/** One machine of the cluster, as the admin's picker shows it. */
export interface ClusterNode {
  /** The value of the label `kubernetes.io/hostname` (what a pod's `nodeSelector` names). */
  name: string;
  /** The node reports Ready. A machine that is not Ready cannot be chosen. */
  ready: boolean;
  /** `amd64`, `arm64`, ... or null when the node does not say. */
  architecture: string | null;
  /** What the machine offers to pods, in thousandths of a CPU. This is the node's allocatable amount, not what is left: what is left needs a cluster-wide read of pods, which is not granted. */
  cpuAllocatableMillis: number | null;
  /** The same for memory, in bytes. */
  memoryAllocatableBytes: number | null;
}

/** Where one team's Hermes pod stands. */
export interface PodPlacement {
  teamId: string;
  /** `running`: a pod runs. `pending`: a pod exists and is not placed or not started. `absent`: no pod (the team has no managed bots, or it is scaled to zero). */
  phase: 'running' | 'pending' | 'absent';
  /** The machine the pod runs or waits on (null while it has none). */
  node: string | null;
  /** The machine the team's work volume lives on (null when it has none yet or the volume is not tied to a machine). */
  volumeNode: string | null;
  /** The controller is recreating the pod's volumes on another machine right now. */
  moving: boolean;
  /**
   * The wanted machine of the team's pod differs from the one its volumes are tied to, and nobody has confirmed the move: the controller has changed nothing and keeps the
   * pod where its data is. The admin confirms the move on the Runners page (the machine dialog).
   */
  moveHeld: boolean;
  /** One plain word from the pod's own condition for a pending pod: `unschedulable`, `starting` or null. Never the cluster's text. */
  pendingReason: 'unschedulable' | 'starting' | null;
}

export interface RunnerNodesProvider extends ProviderImpl {
  id: 'runner.nodes';
  /** Every machine of the cluster (the operator's allowlist is applied by the caller). Rejects when the cluster cannot be asked. */
  listNodes(): Promise<ClusterNode[]>;
  /** Where the pods of the given teams stand (`null`: every team that has a pod). */
  podPlacements(query: { teamIds: readonly string[] | null }): Promise<PodPlacement[]>;
  /**
   * An admin confirmed, on the Runners page, that the given teams' pods may be moved to `node` (their volumes recreated empty there). Writes a time-limited mark on the teams'
   * volume claims; the controller deletes a volume only when it finds that mark for the machine it is moving to. `node: null` clears the mark. Returns how many claims were marked
   * or cleared. Rejects when the cluster cannot be asked.
   */
  confirmMove(input: { teamIds: readonly string[] | null; node: string | null }): Promise<number>;
}
