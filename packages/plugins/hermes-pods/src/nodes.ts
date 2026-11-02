import type { ClusterNode, PodPlacement, RunnerNodesProvider } from '@manythreads/sdk';
import { RunnerNodeName } from '@manythreads/shared';
import type { K8s, K8sObject } from './k8s.ts';
import { confirmMark, needsNodeLookup, volumeSite } from './move.ts';
import { MOVE_CONFIRMED_ANNOTATION, MOVE_HELD_ANNOTATION, MOVING_ANNOTATION } from './render.ts';

// The node-lister (PLAN P19-08): the `runner.nodes` provider that bot-runners asks for the admin's node picker. The real one reads the cluster's nodes and this
// namespace's pods, claims and Deployments through the controller's own client; a test hands it a fake `K8s` and a fake node source. It reads only: nothing here
// writes, and the only cluster-wide right it needs is `get` and `list` on `nodes` (docs/plugins/security.md).

/** `4`, `3920m`, `250m` to thousandths of a CPU. Null for anything else. */
export function parseCpuMillis(q: unknown): number | null {
  if (typeof q !== 'string' && typeof q !== 'number') return null;
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(String(q).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2] === 'm' ? n : n * 1000);
}

const UNITS: Readonly<Record<string, number>> = {
  '': 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
};

/** `16384Mi`, `8Gi`, `123456Ki`, `1000000000` to bytes. Null for anything else. */
export function parseMemoryBytes(q: unknown): number | null {
  if (typeof q !== 'string' && typeof q !== 'number') return null;
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]{0,2})$/.exec(String(q).trim());
  if (!m || UNITS[m[2]!] === undefined) return null;
  return Math.round(Number(m[1]) * UNITS[m[2]!]!);
}

interface NodeObject extends K8sObject {
  spec?: { unschedulable?: boolean };
  status?: {
    conditions?: { type?: string; status?: string }[];
    allocatable?: { cpu?: unknown; memory?: unknown };
    nodeInfo?: { architecture?: string };
  };
}

/** A node object as the picker shows it. A node that cannot be named in a `nodeSelector` is left out: it could not be chosen. */
export function toClusterNode(obj: K8sObject): ClusterNode | null {
  const n = obj as NodeObject;
  const name = n.metadata.labels?.['kubernetes.io/hostname'] ?? n.metadata.name;
  if (!RunnerNodeName.safeParse(name).success) return null;
  const ready = (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
  return {
    name,
    // A node that is cordoned (marked unschedulable) takes no new pod, so it is not a place to put one.
    ready: ready && n.spec?.unschedulable !== true,
    architecture: n.status?.nodeInfo?.architecture ?? n.metadata.labels?.['kubernetes.io/arch'] ?? null,
    cpuAllocatableMillis: parseCpuMillis(n.status?.allocatable?.cpu),
    memoryAllocatableBytes: parseMemoryBytes(n.status?.allocatable?.memory),
  };
}

const POD_SELECTOR = 'app.kubernetes.io/component=hermes-pod,app.kubernetes.io/managed-by=manythreads-hermes-pods';

interface PodObject extends K8sObject {
  spec?: { nodeName?: string };
  status?: { phase?: string; conditions?: { type?: string; status?: string; reason?: string }[] };
}

export interface RunnerNodesSources {
  /** The client for the pods namespace. */
  k8s: () => K8s;
  /** The cluster's node objects (the one cluster-wide read). */
  nodes: () => Promise<K8sObject[]>;
  namespace: string;
  /** The clock (a test sets it); the confirmation of a move is stamped with it. */
  now?: () => number;
}

export function createRunnerNodesProvider(src: RunnerNodesSources): RunnerNodesProvider {
  return {
    id: 'runner.nodes',
    async listNodes() {
      return (await src.nodes()).map(toClusterNode).filter((n): n is ClusterNode => n !== null).sort((a, b) => a.name.localeCompare(b.name));
    },
    async podPlacements({ teamIds }) {
      const k8s = src.k8s();
      const [deployments, pods, claims] = await Promise.all([
        k8s.list('Deployment', src.namespace, POD_SELECTOR),
        k8s.list('Pod', src.namespace, POD_SELECTOR),
        k8s.list('PersistentVolumeClaim', src.namespace, POD_SELECTOR),
      ]);
      const wanted = teamIds === null ? null : new Set(teamIds);
      const byTeam = new Map<string, PodPlacement>();
      const entry = (teamId: string): PodPlacement | null => {
        if (wanted !== null && !wanted.has(teamId)) return null;
        let e = byTeam.get(teamId);
        if (!e) {
          e = { teamId, phase: 'absent', node: null, volumeNode: null, moving: false, moveHeld: false, pendingReason: null };
          byTeam.set(teamId, e);
        }
        return e;
      };
      for (const d of deployments) {
        const e = entry(d.metadata.labels?.['manythreads.io/team-id'] ?? '');
        if (!e) continue;
        if (d.metadata.annotations?.[MOVING_ANNOTATION] !== undefined) e.moving = true;
        if (d.metadata.annotations?.[MOVE_HELD_ANNOTATION] !== undefined) e.moveHeld = true;
      }
      // the work volume is the one the page talks about (two claims per team: workspace and home); a claim with only the scheduler's note is mapped to its hostname
      const workClaims = claims.filter((c) => c.metadata.name.endsWith('-workspace'));
      const lookup = workClaims.some((c) => needsNodeLookup(c)) ? await src.nodes().catch(() => null) : null;
      for (const c of workClaims) {
        const e = entry(c.metadata.labels?.['manythreads.io/team-id'] ?? '');
        if (e) e.volumeNode = volumeSite(c, lookup).node;
      }
      for (const p of pods as PodObject[]) {
        const e = entry(p.metadata.labels?.['manythreads.io/team-id'] ?? '');
        if (!e) continue;
        const phase = p.status?.phase;
        if (phase === 'Running') {
          if (e.phase !== 'pending') {
            e.phase = 'running';
            e.node = p.spec?.nodeName ?? null;
          }
        } else if (phase === 'Pending' || phase === undefined) {
          e.phase = 'pending';
          e.node = p.spec?.nodeName ?? null;
          const unplaced = (p.status?.conditions ?? []).some((c) => c.type === 'PodScheduled' && c.status === 'False');
          e.pendingReason = unplaced ? 'unschedulable' : 'starting';
        }
      }
      return [...byTeam.values()].filter((e) => e.teamId !== '');
    },
    async confirmMove({ teamIds, node }) {
      const k8s = src.k8s();
      const annotate = k8s.annotate?.bind(k8s);
      if (!annotate) throw new Error('this cluster client cannot annotate objects');
      const wanted = teamIds === null ? null : new Set(teamIds);
      const claims = await k8s.list('PersistentVolumeClaim', src.namespace, POD_SELECTOR);
      const mark = node === null ? null : confirmMark(node, (src.now ?? Date.now)());
      let n = 0;
      for (const c of claims) {
        const team = c.metadata.labels?.['manythreads.io/team-id'] ?? '';
        if (team === '' || (wanted !== null && !wanted.has(team))) continue;
        // only the mark is set (or removed); with `null` a claim that has none is left alone
        if (mark === null && c.metadata.annotations?.[MOVE_CONFIRMED_ANNOTATION] === undefined) continue;
        await annotate('PersistentVolumeClaim', src.namespace, c.metadata.name, { [MOVE_CONFIRMED_ANNOTATION]: mark });
        n += 1;
      }
      return n;
    },
  };
}
