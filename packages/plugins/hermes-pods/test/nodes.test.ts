/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed Kubernetes documents whose shape the assertions then pin */
import type { GatewayProfileSpec, PluginLogger } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import type { K8s, K8sObject } from '../src/k8s.ts';
import { nodeOfTeam } from '../src/index.ts';
import { CONFIRM_WINDOW_MS, confirmMark } from '../src/move.ts';
import { createRunnerNodesProvider, parseCpuMillis, parseMemoryBytes, toClusterNode } from '../src/nodes.ts';
import { Reconciler, type ProfileSource } from '../src/reconcile.ts';
import {
  MOVE_CONFIRMED_ANNOTATION,
  MOVE_HELD_ANNOTATION,
  MOVING_ANNOTATION,
  NODE_ANNOTATION,
  SELECTED_NODE_ANNOTATION,
  buildDeployment,
  buildPvc,
  namesFor,
  type PodConfig,
} from '../src/render.ts';

// P19-08: the node a pod runner stands on. The renderer pins the team's pod with `nodeSelector: kubernetes.io/hostname`; the controller moves a pod whose volumes
// are tied to another machine and an admin confirmed the move (stop, delete the two volume claims, make them new) and never touches a Secret; any other change of the
// machine is held and deletes nothing; the node-lister reads machines and pods.

class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  readonly deleted: string[] = [];
  readonly nodes: K8sObject[] = [];
  listNodes?: () => Promise<K8sObject[]> = async () => structuredClone(this.nodes);
  private key(kind: string, ns: string, name: string): string {
    return `${kind}/${ns}/${name}`;
  }
  async apply(obj: K8sObject): Promise<void> {
    const key = this.key(obj.kind, obj.metadata.namespace!, obj.metadata.name);
    const next = structuredClone(obj);
    // server-side apply keeps what other writers put on an object: the scheduler's note and the admin's confirmation stay on a claim
    const old = this.store.get(key);
    if (old && obj.kind === 'PersistentVolumeClaim') {
      const kept = Object.fromEntries(Object.entries(old.metadata.annotations ?? {}).filter(([k]) => k === SELECTED_NODE_ANNOTATION || k === MOVE_CONFIRMED_ANNOTATION));
      const merged = { ...(next.metadata.annotations ?? {}), ...kept };
      if (Object.keys(merged).length > 0) next.metadata.annotations = merged;
    }
    this.store.set(key, next);
  }
  async annotate(kind: string, ns: string, name: string, annotations: Record<string, string | null>): Promise<void> {
    const o = this.store.get(this.key(kind, ns, name))!;
    const next = { ...(o.metadata.annotations ?? {}) };
    for (const [k, v] of Object.entries(annotations)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    o.metadata.annotations = next;
  }
  /** The admin's confirmation, as the node-lister leaves it on both claims. */
  async markClaims(node: string, at: number): Promise<void> {
    for (const n of ['workspace', 'home']) await this.annotate('PersistentVolumeClaim', 'manythreads', `hermes-engineering-${n}`, { [MOVE_CONFIRMED_ANNOTATION]: confirmMark(node, at) });
  }
  async get(kind: string, ns: string, name: string): Promise<K8sObject | null> {
    const o = this.store.get(this.key(kind, ns, name));
    if (!o) return null;
    if (kind === 'Secret' && o['stringData']) {
      const data = Object.fromEntries(Object.entries(o['stringData'] as Record<string, string>).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
      return { ...o, data };
    }
    return structuredClone(o);
  }
  async delete(kind: string, ns: string, name: string): Promise<void> {
    this.deleted.push(`${kind}/${name}`);
    this.store.delete(this.key(kind, ns, name));
  }
  async list(kind: string, ns: string, selector: string): Promise<K8sObject[]> {
    const wanted = selector.split(',').map((s) => s.split('='));
    return [...this.store.values()].filter((o) => o.kind === kind && o.metadata.namespace === ns && wanted.every(([k, v]) => o.metadata.labels?.[k!] === v));
  }
  /** What the kubelet and the scheduler do: a pod of the Deployment exists on `node`. */
  startPod(node: string): void {
    this.store.set('Pod/manythreads/hermes-engineering-abc', {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'hermes-engineering-abc', namespace: 'manythreads', labels: { 'manythreads.io/pod': 'hermes-engineering' } },
    });
    for (const n of ['workspace', 'home']) this.tag(`PersistentVolumeClaim/manythreads/hermes-engineering-${n}`, { [SELECTED_NODE_ANNOTATION]: node });
  }
  stopPod(): void {
    this.store.delete('Pod/manythreads/hermes-engineering-abc');
  }
  tag(key: string, annotations: Record<string, string>): void {
    const o = this.store.get(key)!;
    o.metadata.annotations = { ...(o.metadata.annotations ?? {}), ...annotations };
  }
}

const CFG: PodConfig = {
  namespace: 'manythreads',
  hermesImage: 'manythreads/hermes-pod:1',
  workbenchImage: 'manythreads/workbench:1',
  workspaceSize: '10Gi',
  homeSize: '2Gi',
  storageClass: 'local-path',
  repos: [],
  repoOriginAllow: [],
  deployerBot: 'deployer',
  appsPrefix: 'apps-',
  appsRouting: 'path',
  appsHost: 'example.test',
  resources: { hermes: {}, workbench: {} },
};
const TEAM = { id: '11111111-1111-4111-8111-111111111111', slug: 'engineering' };
const LOG: PluginLogger = { info: () => undefined, warn: () => undefined };
const spec: GatewayProfileSpec = {
  profile: 'mt-dev',
  botId: 'bot-dev',
  files: { 'SOUL.md': 'I am dev', 'config.yaml': 'model:\n  default: fast\n' },
  secrets: { MCP_TOKEN: 'mcp-dev', LLM_KEY: 'llm-dev', API_SERVER_KEY: 'key-dev-0123456789abcdef' },
};

/** A source whose pinned node can be changed between passes, as an admin does on the Runners page. */
function source(initial: string | null): ProfileSource & { node: string | null } {
  const s: ProfileSource & { node: string | null } = {
    node: initial,
    profilesForTeam: async () => [spec],
    nodeForTeam: async () => s.node,
  };
  return s;
}

const deployment = (k8s: FakeK8s): any => k8s.store.get('Deployment/manythreads/hermes-engineering')!;
const secretNames = (k8s: FakeK8s): string[] => [...k8s.store.keys()].filter((k) => k.startsWith('Secret/')).sort();

describe('the rendered pod (P19-08)', () => {
  const names = namesFor(TEAM);

  it('has no node placement when no node is chosen', () => {
    for (const node of [undefined, null]) {
      const pod = (buildDeployment(CFG, TEAM, names, { replicas: 1, withDeployer: false, node }) as any).spec.template.spec;
      expect(pod.nodeSelector).toBeUndefined();
    }
  });

  it('pins the pod with nodeSelector kubernetes.io/hostname when a node is chosen', () => {
    const dep = buildDeployment(CFG, TEAM, names, { replicas: 1, withDeployer: false, node: 'ubuntu-vm' }) as any;
    expect(dep.spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'ubuntu-vm' });
    expect(dep.metadata.annotations).toBeUndefined();
  });

  it('never sends a value that is not a label value (it would be refused by the cluster or carry text into a selector)', () => {
    for (const node of ['has space', 'a/b', 'x'.repeat(64), '-lead', '']) {
      const pod = (buildDeployment(CFG, TEAM, names, { replicas: 1, withDeployer: false, node }) as any).spec.template.spec;
      expect(pod.nodeSelector, node).toBeUndefined();
    }
  });

  it('marks the Deployment while a move is under way, and labels the volume claims with the machine they were asked for', () => {
    const dep = buildDeployment(CFG, TEAM, names, { replicas: 0, withDeployer: false, node: 'w2', moving: true }) as any;
    expect(dep.metadata.annotations).toEqual({ [MOVING_ANNOTATION]: 'w2' });
    expect((buildPvc(CFG, TEAM, names.workspace, '10Gi', 'w2') as any).metadata.annotations).toEqual({ [NODE_ANNOTATION]: 'w2' });
    expect((buildPvc(CFG, TEAM, names.workspace, '10Gi') as any).metadata.annotations).toBeUndefined();
  });

  it('the controller applies the nodeSelector to every team pod that has a chosen node, and none to a pod without one', async () => {
    const k8s = new FakeK8s();
    const src = source('ubuntu-vm');
    const r = await new Reconciler(k8s, CFG, src, LOG, () => 'KEY').reconcileTeam(TEAM);
    expect(r).toMatchObject({ node: 'ubuntu-vm', moving: false });
    expect(deployment(k8s).spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'ubuntu-vm' });
    // a second team of the same runner gets the same placement
    await new Reconciler(k8s, CFG, src, LOG, () => 'KEY').reconcileTeam({ id: '22222222-2222-4222-8222-222222222222', slug: 'marketing' });
    expect((k8s.store.get('Deployment/manythreads/hermes-marketing') as any).spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'ubuntu-vm' });
    const free = new FakeK8s();
    await new Reconciler(free, CFG, source(null), LOG, () => 'KEY').reconcileTeam(TEAM);
    expect(deployment(free).spec.template.spec.nodeSelector).toBeUndefined();
  });

  it('does not pin when the platform hands over a name that is not a node name', async () => {
    const k8s = new FakeK8s();
    const warned: string[] = [];
    await new Reconciler(k8s, CFG, source('bad name; drop'), { info: () => undefined, warn: (m) => void warned.push(m) }, () => 'KEY').reconcileTeam(TEAM);
    expect(deployment(k8s).spec.template.spec.nodeSelector).toBeUndefined();
    expect(warned.join('\n')).toContain('not pinned');
    expect(warned.join('\n')).not.toContain('bad name');
  });
});

/** A node object the way the cluster lists it; `object` is its name, `hostname` the label the picker and the nodeSelector use (they can differ). */
const nodeObject = (object: string, over: { hostname?: string; ready?: boolean } = {}): K8sObject => ({
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name: object, labels: { 'kubernetes.io/hostname': over.hostname ?? object } },
  spec: {},
  status: { conditions: [{ type: 'Ready', status: over.ready === false ? 'False' : 'True' }] },
});

const T0 = 1_800_000_000_000;

/** The reconciler with a clock the test sets. */
function make(k8s: FakeK8s, src: ProfileSource, cfg: PodConfig = CFG, log: PluginLogger = LOG): { rec: Reconciler; clock: { now: number } } {
  const clock = { now: T0 };
  return { rec: new Reconciler(k8s, cfg, src, log, () => 'KEY', () => clock.now), clock };
}

describe('a change of the machine never moves a pod by itself (P19-08)', () => {
  it('holds: the volumes are on one machine, another is now chosen, nobody confirmed. The pod keeps running there, the claims stay, nothing is deleted', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const { rec } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');

    // Make default, Enable/Disable, a Teams edit or a second runner: the computed machine changes with no admin move
    src.node = 'worker-2';
    for (let i = 0; i < 3; i++) {
      const r = await rec.reconcileTeam(TEAM);
      expect(r).toMatchObject({ node: 'ubuntu-vm', moving: false, held: 'worker-2' });
    }
    expect(k8s.deleted).toEqual([]);
    expect(deployment(k8s).spec.replicas).toBe(1);
    expect(deployment(k8s).spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'ubuntu-vm' });
    expect(deployment(k8s).metadata.annotations).toEqual({ [MOVE_HELD_ANNOTATION]: 'worker-2' });
    // the claims keep saying where the data is
    expect((k8s.store.get('PersistentVolumeClaim/manythreads/hermes-engineering-workspace') as any).metadata.annotations[NODE_ANNOTATION]).toBe('ubuntu-vm');

    // the choice goes back: the hold clears by itself
    src.node = 'ubuntu-vm';
    expect(await rec.reconcileTeam(TEAM)).toMatchObject({ node: 'ubuntu-vm', held: null });
    expect(deployment(k8s).metadata.annotations).toBeUndefined();
  });

  it('a new pod (no volume claims yet) is simply pinned to the machine chosen', async () => {
    const k8s = new FakeK8s();
    const { rec } = make(k8s, source('worker-2'));
    expect(await rec.reconcileTeam(TEAM)).toMatchObject({ node: 'worker-2', moving: false, held: null });
    expect(k8s.deleted).toEqual([]);
  });

  it('holds when the confirmation is for another machine, is older than the window, or covers only one of the two claims', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const { rec, clock } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');
    src.node = 'worker-2';

    await k8s.markClaims('worker-3', T0);
    expect((await rec.reconcileTeam(TEAM)).held).toBe('worker-2');

    await k8s.markClaims('worker-2', T0);
    clock.now = T0 + CONFIRM_WINDOW_MS + 1;
    expect((await rec.reconcileTeam(TEAM)).held).toBe('worker-2');

    clock.now = T0;
    await k8s.annotate('PersistentVolumeClaim', 'manythreads', 'hermes-engineering-workspace', { [MOVE_CONFIRMED_ANNOTATION]: confirmMark('worker-2', T0) });
    await k8s.annotate('PersistentVolumeClaim', 'manythreads', 'hermes-engineering-home', { [MOVE_CONFIRMED_ANNOTATION]: null });
    expect((await rec.reconcileTeam(TEAM)).held).toBe('worker-2');
    expect(k8s.deleted).toEqual([]);
    expect(deployment(k8s).spec.replicas).toBe(1);
  });
});

describe('moving a pod to another machine (P19-08)', () => {
  it('after the admin confirms: stops the pod, waits for it to be gone, deletes both volume claims, makes them new on the new machine, and keeps every Secret', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const { rec } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');
    const secretsBefore = secretNames(k8s);
    const keyBefore = JSON.stringify(k8s.store.get('Secret/manythreads/hermes-engineering-key'));
    const profilesBefore = JSON.stringify(k8s.store.get('Secret/manythreads/hermes-engineering-profiles'));
    expect(secretsBefore).toContain('Secret/manythreads/hermes-engineering-key');

    // the admin picks another machine and confirms the move
    src.node = 'worker-2';
    await k8s.markClaims('worker-2', T0);
    const first = await rec.reconcileTeam(TEAM);
    expect(first).toMatchObject({ node: 'worker-2', moving: true, held: null });
    expect(deployment(k8s).spec.replicas).toBe(0);
    expect(deployment(k8s).metadata.annotations).toEqual({ [MOVING_ANNOTATION]: 'worker-2' });
    // the pod is still stopping: nothing is deleted yet
    expect(k8s.deleted).toEqual([]);
    expect(k8s.store.has('PersistentVolumeClaim/manythreads/hermes-engineering-workspace')).toBe(true);

    k8s.stopPod();
    const second = await rec.reconcileTeam(TEAM);
    expect(second.moving).toBe(true);
    expect(k8s.deleted.sort()).toEqual(['PersistentVolumeClaim/hermes-engineering-home', 'PersistentVolumeClaim/hermes-engineering-workspace']);

    // the claims are gone: the next pass makes them new, annotated with the new machine, and starts the pod there
    const third = await rec.reconcileTeam(TEAM);
    expect(third).toMatchObject({ node: 'worker-2', moving: false, held: null });
    expect(deployment(k8s).spec.replicas).toBe(1);
    expect(deployment(k8s).metadata.annotations).toBeUndefined();
    expect(deployment(k8s).spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'worker-2' });
    expect((k8s.store.get('PersistentVolumeClaim/manythreads/hermes-engineering-workspace') as any).metadata.annotations).toEqual({ [NODE_ANNOTATION]: 'worker-2' });

    // the Secrets: none deleted, the gateway key and the profiles are exactly what they were
    expect(k8s.deleted.filter((d) => d.startsWith('Secret'))).toEqual([]);
    expect(secretNames(k8s)).toEqual(secretsBefore);
    expect(JSON.stringify(k8s.store.get('Secret/manythreads/hermes-engineering-key'))).toBe(keyBefore);
    expect(JSON.stringify(k8s.store.get('Secret/manythreads/hermes-engineering-profiles'))).toBe(profilesBefore);
  });

  it('keeps waiting while a pod remains and deletes no claim until it is gone', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const { rec } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');
    src.node = 'worker-2';
    await k8s.markClaims('worker-2', T0);
    for (let i = 0; i < 3; i++) await rec.reconcileTeam(TEAM);
    expect(k8s.deleted).toEqual([]);
  });

  it('a move under way finishes even after the confirmation has run out (the pod is already stopped)', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const { rec, clock } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');
    src.node = 'worker-2';
    await k8s.markClaims('worker-2', T0);
    await rec.reconcileTeam(TEAM);
    clock.now = T0 + 2 * CONFIRM_WINDOW_MS;
    k8s.stopPod();
    await rec.reconcileTeam(TEAM);
    expect(k8s.deleted).toHaveLength(2);
  });

  it('deletes the claim that is left when the other is already gone (both go, or neither stays tied to the old machine)', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const { rec } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');
    src.node = 'worker-2';
    await k8s.markClaims('worker-2', T0);
    await rec.reconcileTeam(TEAM);
    k8s.stopPod();
    k8s.store.delete('PersistentVolumeClaim/manythreads/hermes-engineering-home');
    await rec.reconcileTeam(TEAM);
    expect(k8s.deleted).toEqual(['PersistentVolumeClaim/hermes-engineering-workspace']);
  });

  it('deletes nothing when the chosen machine cannot be checked: not Ready, not allowed, not in the cluster, or the node list unreadable', async () => {
    const cases: { name: string; nodes: K8sObject[]; cfg?: Partial<PodConfig>; noList?: boolean; failList?: boolean }[] = [
      { name: 'not ready', nodes: [nodeObject('ubuntu-vm'), nodeObject('worker-2', { ready: false })] },
      { name: 'not allowed', nodes: [nodeObject('ubuntu-vm'), nodeObject('worker-2')], cfg: { allowedNodes: ['ubuntu-vm'] } },
      { name: 'not a node', nodes: [nodeObject('ubuntu-vm')] },
      { name: 'no list', nodes: [], noList: true },
      { name: 'list fails', nodes: [nodeObject('ubuntu-vm'), nodeObject('worker-2')], failList: true },
    ];
    for (const c of cases) {
      const k8s = new FakeK8s();
      k8s.nodes.push(...c.nodes);
      const src = source('ubuntu-vm');
      const { rec } = make(k8s, src, { ...CFG, ...c.cfg });
      await rec.reconcileTeam(TEAM);
      k8s.startPod('ubuntu-vm');
      src.node = 'worker-2';
      await k8s.markClaims('worker-2', T0);
      if (c.noList) k8s.listNodes = undefined;
      if (c.failList) k8s.listNodes = async () => Promise.reject(new Error('forbidden'));
      const r = await rec.reconcileTeam(TEAM);
      // not started: the pod keeps running where its volumes are
      expect(r, c.name).toMatchObject({ node: 'ubuntu-vm', moving: false, held: 'worker-2' });
      expect(deployment(k8s).spec.replicas, c.name).toBe(1);
      k8s.stopPod();
      await rec.reconcileTeam(TEAM);
      expect(k8s.deleted, c.name).toEqual([]);
    }
  });

  it('a move under way whose machine can no longer be checked stays stopped and deletes nothing', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const { rec } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');
    src.node = 'worker-2';
    await k8s.markClaims('worker-2', T0);
    await rec.reconcileTeam(TEAM);
    k8s.stopPod();
    k8s.nodes.length = 0;
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2', { ready: false }));
    const r = await rec.reconcileTeam(TEAM);
    expect(r).toMatchObject({ moving: true });
    expect(deployment(k8s).spec.replicas).toBe(0);
    expect(k8s.deleted).toEqual([]);
  });

  it('deletes no claim that does not carry the team id label (and then none at all)', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const warned: string[] = [];
    const { rec } = make(k8s, src, CFG, { info: () => undefined, warn: (m) => void warned.push(m) });
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');
    src.node = 'worker-2';
    await k8s.markClaims('worker-2', T0);
    await rec.reconcileTeam(TEAM);
    k8s.stopPod();
    (k8s.store.get('PersistentVolumeClaim/manythreads/hermes-engineering-home') as any).metadata.labels['manythreads.io/team-id'] = 'another-team';
    await rec.reconcileTeam(TEAM);
    expect(k8s.deleted).toEqual([]);
    expect(warned.join('\n')).toContain("does not carry this team's id");
  });

  it('does not move when the volumes are already on the chosen machine, when the claims say nothing about a machine, or when the node is cleared', async () => {
    const same = new FakeK8s();
    const srcSame = source('ubuntu-vm');
    const recSame = make(same, srcSame).rec;
    await recSame.reconcileTeam(TEAM);
    same.startPod('ubuntu-vm');
    expect((await recSame.reconcileTeam(TEAM)).moving).toBe(false);

    const unknown = new FakeK8s();
    const srcUnknown = source(null);
    const recUnknown = make(unknown, srcUnknown).rec;
    await recUnknown.reconcileTeam(TEAM);
    srcUnknown.node = 'worker-2';
    expect((await recUnknown.reconcileTeam(TEAM)).moving).toBe(false);
    expect(unknown.deleted).toEqual([]);

    const cleared = new FakeK8s();
    const srcCleared = source('ubuntu-vm');
    const recCleared = make(cleared, srcCleared).rec;
    await recCleared.reconcileTeam(TEAM);
    cleared.startPod('ubuntu-vm');
    srcCleared.node = null;
    expect((await recCleared.reconcileTeam(TEAM)).moving).toBe(false);
    expect(deployment(cleared).spec.template.spec.nodeSelector).toBeUndefined();
    expect(cleared.deleted).toEqual([]);
  });

  it('a failed read of the chosen node fails the pass and changes nothing (a team is never silently unpinned or moved)', async () => {
    const k8s = new FakeK8s();
    const failing: ProfileSource = { profilesForTeam: async () => [spec], nodeForTeam: async () => Promise.reject(new Error('database down')) };
    await expect(make(k8s, failing).rec.reconcileTeam(TEAM)).rejects.toThrow('database down');
    expect(k8s.store.size).toBe(0);
  });
});

describe('a node whose object name differs from its hostname label (P19-08)', () => {
  // the scheduler writes the Node's object name into selected-node; the picker, the nodeSelector and the database use the hostname label
  const legacy = async (k8s: FakeK8s, src: ReturnType<typeof source>, onlySelected: boolean): Promise<Reconciler> => {
    const { rec } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('node-object-a');
    if (onlySelected) for (const n of ['workspace', 'home']) delete (k8s.store.get(`PersistentVolumeClaim/manythreads/hermes-engineering-${n}`) as any).metadata.annotations[NODE_ANNOTATION];
    return rec;
  };

  it('a claim made on the right machine is not judged stale on the next pass, however often the controller runs', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('node-object-a', { hostname: 'ubuntu-vm' }));
    const rec = await legacy(k8s, source('ubuntu-vm'), false);
    for (let i = 0; i < 4; i++) expect(await rec.reconcileTeam(TEAM)).toMatchObject({ moving: false, held: null });
    expect(k8s.deleted).toEqual([]);
  });

  it('a claim with only the scheduler note is mapped from the node name to the hostname before it is judged', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('node-object-a', { hostname: 'ubuntu-vm' }));
    const rec = await legacy(k8s, source('ubuntu-vm'), true);
    for (let i = 0; i < 3; i++) expect(await rec.reconcileTeam(TEAM)).toMatchObject({ moving: false, held: null });
    expect(k8s.deleted).toEqual([]);
    // and a real difference is still seen
    const other = new FakeK8s();
    other.nodes.push(nodeObject('node-object-a', { hostname: 'ubuntu-vm' }), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const recOther = await legacy(other, src, true);
    src.node = 'worker-2';
    expect(await recOther.reconcileTeam(TEAM)).toMatchObject({ node: 'ubuntu-vm', held: 'worker-2' });
  });

  it('a claim with only the scheduler note and no way to map it is never judged stale, and is not stamped with a machine it may not be on', async () => {
    const k8s = new FakeK8s();
    const src = source('ubuntu-vm');
    const rec = await legacy(k8s, src, true);
    expect(await rec.reconcileTeam(TEAM)).toMatchObject({ moving: false, held: null });
    expect((k8s.store.get('PersistentVolumeClaim/manythreads/hermes-engineering-workspace') as any).metadata.annotations[NODE_ANNOTATION]).toBeUndefined();
    expect(k8s.deleted).toEqual([]);
  });

  it('this controller\'s own note wins over the scheduler\'s', async () => {
    const k8s = new FakeK8s();
    const rec = await legacy(k8s, source('ubuntu-vm'), false);
    // selected-node names the object ("node-object-a"), the controller's note names the hostname ("ubuntu-vm"): equal machines
    expect(await rec.reconcileTeam(TEAM)).toMatchObject({ moving: false, held: null });
    expect(k8s.deleted).toEqual([]);
  });
});

describe('a pod stopped for a move is still looked at when its team has no managed bots (P19-08)', () => {
  it('reconcileAll gives a replicas-0 Deployment that carries the moving mark one more pass', async () => {
    const k8s = new FakeK8s();
    k8s.nodes.push(nodeObject('ubuntu-vm'), nodeObject('worker-2'));
    const src = source('ubuntu-vm');
    const { rec } = make(k8s, src);
    await rec.reconcileTeam(TEAM);
    k8s.startPod('ubuntu-vm');
    src.node = 'worker-2';
    await k8s.markClaims('worker-2', T0);
    await rec.reconcileTeam(TEAM);
    k8s.stopPod();
    // the team lost its managed bots: it is no longer in the list of teams, and its pod is already at zero
    const results = await rec.reconcileAll([]);
    expect(results.map((r) => r.team)).toEqual(['engineering']);
    expect(k8s.deleted.sort()).toEqual(['PersistentVolumeClaim/hermes-engineering-home', 'PersistentVolumeClaim/hermes-engineering-workspace']);
    // a replicas-0 Deployment with no mark is left alone as before
    const quiet = new FakeK8s();
    const { rec: quietRec } = make(quiet, source(null));
    await quietRec.reconcileTeam(TEAM, []);
    expect(await quietRec.reconcileAll([])).toEqual([]);
  });
});

describe('the node-lister (P19-08)', () => {
  const node = (name: string, extra: Record<string, unknown> = {}): K8sObject => ({
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name, labels: { 'kubernetes.io/hostname': name, 'kubernetes.io/arch': 'amd64' } },
    spec: {},
    status: { conditions: [{ type: 'Ready', status: 'True' }], allocatable: { cpu: '4', memory: '16384Mi' }, nodeInfo: { architecture: 'amd64' } },
    ...extra,
  });

  it('reads the quantities Kubernetes writes', () => {
    expect(parseCpuMillis('4')).toBe(4000);
    expect(parseCpuMillis('3920m')).toBe(3920);
    expect(parseCpuMillis('0.5')).toBe(500);
    expect(parseCpuMillis('x')).toBeNull();
    expect(parseMemoryBytes('16384Mi')).toBe(16384 * 1024 * 1024);
    expect(parseMemoryBytes('8Gi')).toBe(8 * 1024 ** 3);
    expect(parseMemoryBytes('123456Ki')).toBe(123456 * 1024);
    expect(parseMemoryBytes('1000000')).toBe(1_000_000);
    expect(parseMemoryBytes('12Zi')).toBeNull();
  });

  it('lists a Ready node, a node that is not Ready and a cordoned node; only the first can take a pod', () => {
    expect(toClusterNode(node('ubuntu-vm'))).toEqual({ name: 'ubuntu-vm', ready: true, architecture: 'amd64', cpuAllocatableMillis: 4000, memoryAllocatableBytes: 16384 * 1024 * 1024 });
    expect(toClusterNode(node('w2', { status: { conditions: [{ type: 'Ready', status: 'False' }] } }))?.ready).toBe(false);
    expect(toClusterNode(node('w3', { spec: { unschedulable: true } }))?.ready).toBe(false);
    expect(toClusterNode(node('has space'))).toBeNull();
  });

  const pod = (team: string, over: Record<string, unknown>): K8sObject => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `hermes-${team}-x`,
      namespace: 'manythreads',
      labels: { 'app.kubernetes.io/component': 'hermes-pod', 'app.kubernetes.io/managed-by': 'manythreads-hermes-pods', 'manythreads.io/team-id': team },
    },
    ...over,
  });
  const claim = (team: string, annotations: Record<string, string>): K8sObject => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: `hermes-${team}-workspace`,
      namespace: 'manythreads',
      labels: { 'app.kubernetes.io/component': 'hermes-pod', 'app.kubernetes.io/managed-by': 'manythreads-hermes-pods', 'manythreads.io/team-id': team },
      annotations,
    },
  });

  it('tells a running pod, a pod that cannot be placed (its Pending condition), a move and the node of a work volume', async () => {
    const k8s = new FakeK8s();
    for (const o of [
      pod('t-run', { spec: { nodeName: 'ubuntu-vm' }, status: { phase: 'Running' } }),
      pod('t-wait', { spec: {}, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] } }),
      pod('t-start', { spec: { nodeName: 'ubuntu-vm' }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'True' }] } }),
      claim('t-run', { [SELECTED_NODE_ANNOTATION]: 'ubuntu-vm' }),
      claim('t-move', { [NODE_ANNOTATION]: 'w2' }),
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'hermes-t-move', namespace: 'manythreads', labels: { 'app.kubernetes.io/component': 'hermes-pod', 'app.kubernetes.io/managed-by': 'manythreads-hermes-pods', 'manythreads.io/team-id': 't-move' }, annotations: { [MOVING_ANNOTATION]: 'w2' } } },
    ])
      await k8s.apply(o);
    const provider = createRunnerNodesProvider({ k8s: () => k8s, nodes: async () => [node('ubuntu-vm')], namespace: 'manythreads' });
    const all = await provider.podPlacements({ teamIds: null });
    const by = (t: string) => all.find((p) => p.teamId === t);
    expect(by('t-run')).toMatchObject({ phase: 'running', node: 'ubuntu-vm', volumeNode: 'ubuntu-vm', moving: false });
    expect(by('t-wait')).toMatchObject({ phase: 'pending', pendingReason: 'unschedulable', node: null });
    expect(by('t-start')).toMatchObject({ phase: 'pending', pendingReason: 'starting', node: 'ubuntu-vm' });
    expect(by('t-move')).toMatchObject({ phase: 'absent', moving: true, volumeNode: 'w2' });
    expect((await provider.podPlacements({ teamIds: ['t-run'] })).map((p) => p.teamId)).toEqual(['t-run']);
    expect((await provider.listNodes()).map((n) => n.name)).toEqual(['ubuntu-vm']);
  });
});

describe('the node-lister reads and records the move state (P19-08)', () => {
  const LABELS = { 'app.kubernetes.io/component': 'hermes-pod', 'app.kubernetes.io/managed-by': 'manythreads-hermes-pods' };
  const claimOf = (team: string, name: string, annotations: Record<string, string>): K8sObject => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: 'manythreads', labels: { ...LABELS, 'manythreads.io/team-id': team }, annotations },
  });
  const nodeObj = (object: string, hostname: string): K8sObject => ({ apiVersion: 'v1', kind: 'Node', metadata: { name: object, labels: { 'kubernetes.io/hostname': hostname } }, status: {} });

  it('reports a held move, and maps a claim that has only the scheduler note to the hostname', async () => {
    const k8s = new FakeK8s();
    await k8s.apply({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'hermes-t-1', namespace: 'manythreads', labels: { ...LABELS, 'manythreads.io/team-id': 't-1' }, annotations: { [MOVE_HELD_ANNOTATION]: 'worker-2' } } });
    await k8s.apply(claimOf('t-1', 'hermes-t-1-workspace', { [SELECTED_NODE_ANNOTATION]: 'node-object-a' }));
    const provider = createRunnerNodesProvider({ k8s: () => k8s, nodes: async () => [nodeObj('node-object-a', 'ubuntu-vm')], namespace: 'manythreads' });
    expect((await provider.podPlacements({ teamIds: null }))[0]).toMatchObject({ teamId: 't-1', moveHeld: true, moving: false, volumeNode: 'ubuntu-vm' });
    // a name that cannot be mapped is not a machine name: no value is made up
    const blind = createRunnerNodesProvider({ k8s: () => k8s, nodes: async () => [], namespace: 'manythreads' });
    expect((await blind.podPlacements({ teamIds: null }))[0]).toMatchObject({ volumeNode: null });
  });

  it("confirmMove marks only the named teams' claims with the machine and the time, and null takes the mark off", async () => {
    const k8s = new FakeK8s();
    for (const [team, name] of [
      ['t-1', 'hermes-t-1-workspace'],
      ['t-1', 'hermes-t-1-home'],
      ['t-2', 'hermes-t-2-workspace'],
    ] as const)
      await k8s.apply(claimOf(team, name, { [NODE_ANNOTATION]: 'ubuntu-vm' }));
    const provider = createRunnerNodesProvider({ k8s: () => k8s, nodes: async () => [], namespace: 'manythreads', now: () => T0 });
    expect(await provider.confirmMove({ teamIds: ['t-1'], node: 'worker-2' })).toBe(2);
    const mark = (n: string): string | undefined => k8s.store.get(`PersistentVolumeClaim/manythreads/${n}`)?.metadata.annotations?.[MOVE_CONFIRMED_ANNOTATION];
    expect(mark('hermes-t-1-workspace')).toBe(confirmMark('worker-2', T0));
    expect(mark('hermes-t-1-home')).toBe(confirmMark('worker-2', T0));
    expect(mark('hermes-t-2-workspace')).toBeUndefined();
    // the machine of the volume is not touched
    expect(k8s.store.get('PersistentVolumeClaim/manythreads/hermes-t-1-workspace')?.metadata.annotations?.[NODE_ANNOTATION]).toBe('ubuntu-vm');
    expect(await provider.confirmMove({ teamIds: null, node: 'worker-3' })).toBe(3);
    expect(await provider.confirmMove({ teamIds: null, node: null })).toBe(3);
    expect(mark('hermes-t-1-workspace')).toBeUndefined();
    expect(await provider.confirmMove({ teamIds: null, node: null })).toBe(0);
  });

  it('a client that cannot annotate refuses to confirm', async () => {
    const bare: K8s = { apply: async () => undefined, get: async () => null, list: async () => [], delete: async () => undefined };
    const provider = createRunnerNodesProvider({ k8s: () => bare, nodes: async () => [], namespace: 'manythreads' });
    await expect(provider.confirmMove({ teamIds: null, node: 'w2' })).rejects.toThrow('cannot annotate');
  });
});

describe('the pass asks the bot-runners provider (P19-08)', () => {
  it('fails (does not read "no machine") when the bot.runners provider is not loaded', async () => {
    await expect(nodeOfTeam({ providers: { get: () => undefined } } as any, TEAM.id)).rejects.toThrow('bot.runners provider is not loaded');
    const ok = { providers: { get: () => ({ teamRunners: async () => ({ podNode: 'w2' }) }) } } as any;
    expect(await nodeOfTeam(ok, TEAM.id)).toBe('w2');
    const none = { providers: { get: () => ({ teamRunners: async () => ({ podNode: null }) }) } } as any;
    expect(await nodeOfTeam(none, TEAM.id)).toBeNull();
  });
});
