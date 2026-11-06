/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed JSON documents whose shape the assertions then pin */
import type { PluginLogger, PodRunnerInfo, PodRunnerState } from '@manythreads/sdk';
import { confirmMark, type K8s, type K8sObject } from '@manythreads/sdk/pods';
import { describe, expect, it } from 'vitest';
import { configFrom, type ClaudePodConfig } from '../src/config.ts';
import { Reconciler, stateFor, type RunnerSource } from '../src/reconcile.ts';
import { buildBridgeConfig, namesFor, slugForRunner } from '../src/render.ts';

// The controller against an in-memory Kubernetes API (same object in, same object out) and a stand-in for the runner list.

class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  nodes: K8sObject[] = [];
  private key = (kind: string, ns: string, name: string): string => `${kind}/${ns}/${name}`;
  async apply(obj: K8sObject): Promise<void> {
    this.store.set(this.key(obj.kind, obj.metadata.namespace!, obj.metadata.name), structuredClone(obj));
  }
  async get(kind: string, ns: string, name: string): Promise<K8sObject | null> {
    const o = this.store.get(this.key(kind, ns, name));
    if (!o) return null;
    if (kind === 'Secret' && o['stringData']) {
      return { ...o, data: Object.fromEntries(Object.entries(o['stringData'] as Record<string, string>).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
    }
    return structuredClone(o);
  }
  async delete(kind: string, ns: string, name: string): Promise<void> {
    this.store.delete(this.key(kind, ns, name));
  }
  async list(kind: string, ns: string, selector: string): Promise<K8sObject[]> {
    const wanted = selector.split(',').map((s) => s.split('='));
    return [...this.store.values()].filter((o) => o.kind === kind && o.metadata.namespace === ns && wanted.every(([k, v]) => o.metadata.labels?.[k!] === v));
  }
  async listNodes(): Promise<K8sObject[]> {
    return this.nodes;
  }
  snapshot(): string {
    return JSON.stringify([...this.store.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

const CFG: ClaudePodConfig = { ...configFrom({}), namespace: 'bots', image: 'manythreads/claude-pod:1', repoOriginAllow: ['https://github.com/acme/'] };
const logs: string[] = [];
const LOG: PluginLogger = { info: (m) => void logs.push(m), warn: (m) => void logs.push(`WARN ${m}`) };

const runner = (name: string, over: Partial<PodRunnerInfo> = {}): PodRunnerInfo => ({
  id: `00000000-0000-4000-8000-${name.replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12)}`,
  workspaceId: 'w1',
  name,
  enabled: true,
  node: null,
  maxConcurrent: null,
  teams: [{ id: 't-eng', slug: 'engineering' }],
  allTeams: false,
  bots: [{ teamId: 't-eng', teamSlug: 'engineering', botSlug: 'engineer' }],
  ...over,
});

function setup(runners: PodRunnerInfo[], now = (): number => 1_000_000) {
  const k8s = new FakeK8s();
  const reports: PodRunnerState[] = [];
  const source: RunnerSource = {
    runners: async () => runners,
    report: async (s) => void reports.push(s),
    reposForTeams: async () => [
      { teamSlug: 'engineering', name: 'app', origin: 'https://github.com/acme/app.git', branch: 'main' },
      { teamSlug: 'engineering', name: 'evil', origin: 'https://evil.example/x.git' },
    ],
  };
  return { k8s, reports, r: new Reconciler(k8s, CFG, source, LOG, () => 'k'.repeat(48), now) };
}
const signIn = (k8s: FakeK8s, name: string): void => {
  k8s.store.set(`Secret/bots/${namesFor(name).credentials}`, { apiVersion: 'v1', kind: 'Secret', metadata: { name: namesFor(name).credentials, namespace: 'bots' }, data: {} });
};
const dep = (k8s: FakeK8s, name: string): K8sObject => k8s.store.get(`Deployment/bots/${namesFor(name).base}`)!;
const replicas = (k8s: FakeK8s, name: string): number => (dep(k8s, name).spec as { replicas: number }).replicas;

describe('claude-pods objects', () => {
  it('writes a Deployment, Service, ConfigMap, key Secret and two claims per runner, and a second pass changes nothing', async () => {
    const { k8s, r } = setup([runner('claude-test')]);
    signIn(k8s, 'claude-test');
    await r.reconcileAll();
    const first = k8s.snapshot();
    const kinds = [...k8s.store.keys()].map((k) => k.split('/')[0]).sort();
    expect(kinds).toEqual(['ConfigMap', 'Deployment', 'PersistentVolumeClaim', 'PersistentVolumeClaim', 'Role', 'RoleBinding', 'Secret', 'Secret', 'Service', 'ServiceAccount']);
    await r.reconcileAll();
    expect(k8s.snapshot()).toBe(first);
    const d = dep(k8s, 'claude-test') as any;
    expect(d.metadata.name).toBe('claude-claude-test');
    expect(d.spec.strategy).toEqual({ type: 'Recreate' });
    expect(d.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(d.spec.template.spec.containers.map((c: { name: string }) => c.name)).toEqual(['bridge', 'keeper', 'repo-sync']);
    for (const c of [...d.spec.template.spec.containers, ...d.spec.template.spec.initContainers]) expect(c.resources.limits.memory).toBeTruthy();
    const claims = [...k8s.store.values()].filter((o) => o.kind === 'PersistentVolumeClaim').map((o) => [o.metadata.name, (o.spec as any).resources.requests.storage]);
    expect(claims.sort()).toEqual([['claude-claude-test-state', '256Mi'], ['claude-claude-test-work', '10Gi']]);
  });

  it('gives the keeper its own identity: a Role for its one Secret, and a token only the keeper container mounts', async () => {
    const { k8s, r } = setup([runner('claude-test')]);
    signIn(k8s, 'claude-test');
    await r.reconcileAll();
    const names = namesFor('claude-test');
    const role = k8s.store.get(`Role/bots/${names.keeper}`) as any;
    expect(role.rules).toEqual([{ apiGroups: [''], resources: ['secrets'], resourceNames: [names.credentials], verbs: ['get', 'patch'] }]);
    const d = dep(k8s, 'claude-test') as any;
    expect(d.spec.template.spec.serviceAccountName).toBe(names.keeper);
    expect(d.spec.template.spec.automountServiceAccountToken).toBe(false);
    const mounting = d.spec.template.spec.containers.filter((c: any) => c.volumeMounts.some((m: any) => m.name === 'keeper-token')).map((c: any) => c.name);
    expect(mounting).toEqual(['keeper']);
    const keeper = d.spec.template.spec.containers.find((c: any) => c.name === 'keeper');
    expect(keeper.volumeMounts.find((m: any) => m.name === 'state')).toMatchObject({ readOnly: true, subPath: 'claude' });
  });

  it('rolls the pod when a new sign-in file is uploaded (the upload id is on the pod template) and never writes the sign-in Secret itself', async () => {
    const { k8s, r } = setup([runner('claude-test')]);
    const name = namesFor('claude-test').credentials;
    k8s.store.set(`Secret/bots/${name}`, { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: 'bots' }, data: { '.credentials.json': 'eA==', 'upload-id': Buffer.from('up-1').toString('base64') } });
    await r.reconcileAll();
    expect((dep(k8s, 'claude-test') as any).spec.template.metadata.annotations['manythreads.io/upload-id']).toBe('up-1');
    // the keeper's later write is not undone by a pass
    k8s.store.set(`Secret/bots/${name}`, { ...(k8s.store.get(`Secret/bots/${name}`) as any), data: { '.credentials.json': 'bmV3', 'upload-id': Buffer.from('up-1').toString('base64') } });
    await r.reconcileAll();
    expect((k8s.store.get(`Secret/bots/${name}`) as any).data['.credentials.json']).toBe('bmV3');
  });

  it('keeps the bridge key it drew once', async () => {
    let n = 0;
    const k8s = new FakeK8s();
    const r = new Reconciler(k8s, CFG, { runners: async () => [runner('a')] }, LOG, () => `key-${++n}`);
    await r.reconcileAll();
    await r.reconcileAll();
    const sec = await k8s.get('Secret', 'bots', namesFor('a').key);
    expect(Buffer.from((sec!.data as Record<string, string>)['api-key']!, 'base64').toString()).toBe('key-1');
  });

  it('runs no pod without a sign-in, a bot, or while the runner is off', async () => {
    const a = setup([runner('a')]);
    await a.r.reconcileAll();
    expect(replicas(a.k8s, 'a')).toBe(0);
    expect(a.reports.at(-1)?.status).toBe('waiting_for_sign_in');
    signIn(a.k8s, 'a');
    await a.r.reconcileAll();
    expect(replicas(a.k8s, 'a')).toBe(1);

    const b = setup([runner('b', { bots: [] })]);
    signIn(b.k8s, 'b');
    await b.r.reconcileAll();
    expect(replicas(b.k8s, 'b')).toBe(0);

    const c = setup([runner('c', { enabled: false })]);
    signIn(c.k8s, 'c');
    await c.r.reconcileAll();
    expect(replicas(c.k8s, 'c')).toBe(0);
  });

  it('two runners make two disjoint sets of objects, and a Hermes object is never touched', async () => {
    const { k8s, r } = setup([runner('one'), runner('two')]);
    const hermes: K8sObject = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'hermes-engineering', namespace: 'bots', labels: { 'app.kubernetes.io/component': 'hermes-pod' } }, spec: { replicas: 1 } };
    k8s.store.set('Deployment/bots/hermes-engineering', structuredClone(hermes));
    await r.reconcileAll();
    const names = (n: string): string[] => [...k8s.store.values()].filter((o) => o.metadata.name.startsWith(namesFor(n).base)).map((o) => o.metadata.name);
    expect(names('one').filter((x) => names('two').includes(x))).toEqual([]);
    expect(k8s.store.get('Deployment/bots/hermes-engineering')).toEqual(hermes);
  });

  it('scales a Deployment of a vanished runner to zero and keeps its volumes', async () => {
    const live = [runner('gone')];
    const k8s = new FakeK8s();
    const r = new Reconciler(k8s, CFG, { runners: async () => live }, LOG);
    signIn(k8s, 'gone');
    await r.reconcileAll();
    expect(replicas(k8s, 'gone')).toBe(1);
    live.length = 0;
    await r.reconcileAll();
    expect(replicas(k8s, 'gone')).toBe(0);
    expect(k8s.store.has(`PersistentVolumeClaim/bots/${namesFor('gone').work}`)).toBe(true);
  });

  it('names: a runner name with dots, underscores or length gets a valid, distinct Kubernetes name', () => {
    expect(slugForRunner('claude-test')).toBe('claude-test');
    const a = slugForRunner('my.runner_1');
    const b = slugForRunner('my.runner-1');
    expect(a).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(a).not.toBe(b);
    expect(namesFor('x'.repeat(63)).base.length).toBeLessThanOrEqual(63);
  });
});

describe('bridge configuration', () => {
  it('has one profile per placed bot named <team>--<bot>, with its folder, aliases and the where-you-run note', () => {
    const cfg = JSON.parse(buildBridgeConfig(CFG, runner('x', { maxConcurrent: 3, bots: [{ teamId: 'a', teamSlug: 'marketing', botSlug: 'writer' }, { teamId: 'b', teamSlug: 'engineering', botSlug: 'engineer' }] })));
    expect(Object.keys(cfg.profiles)).toEqual(['marketing--writer', 'engineering--engineer']);
    expect(cfg.maxConcurrentRuns).toBe(3);
    const p = cfg.profiles['marketing--writer'];
    expect(p.agent).toBe('claude-code');
    expect(p.workdir).toBe('/work/marketing/writer');
    expect(p.modelAliases.smart).toBe('opus');
    expect(p.env.CLAUDE_CONFIG_DIR).toBe('/state/claude');
    expect(p.instructions).toContain('/work/marketing/writer');
  });

  it('uses the default concurrency when the runner says none', () => {
    expect(JSON.parse(buildBridgeConfig(CFG, runner('x'))).maxConcurrentRuns).toBe(2);
  });

  it('clones only the repositories the origin rule allows, for teams that have a bot here', async () => {
    const { k8s, r } = setup([runner('x')]);
    await r.reconcileAll();
    const cm = await k8s.get('ConfigMap', 'bots', namesFor('x').config);
    expect((cm!.data as Record<string, string>)['repos.txt']).toBe('engineering engineer app main https://github.com/acme/app.git\n');
  });
});

describe('choosing the machine', () => {
  const NODE = (name: string, ready = true): K8sObject => ({ apiVersion: 'v1', kind: 'Node', metadata: { name, labels: { 'kubernetes.io/hostname': name } }, status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] } });

  it('pins the pod and stamps new claims with the machine', async () => {
    const { k8s, r } = setup([runner('n', { node: 'ubuntu-vm' })]);
    await r.reconcileAll();
    expect((dep(k8s, 'n').spec as any).template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'ubuntu-vm' });
    expect(k8s.store.get(`PersistentVolumeClaim/bots/${namesFor('n').work}`)!.metadata.annotations).toEqual({ 'manythreads.io/node': 'ubuntu-vm' });
  });

  it('ignores a node name that is not a label value', async () => {
    const { k8s, r } = setup([runner('n', { node: 'bad name!' })]);
    await r.reconcileAll();
    expect((dep(k8s, 'n').spec as any).template.spec.nodeSelector).toBeUndefined();
  });

  it('holds a change of machine until it is confirmed, then moves: claims deleted, Secrets kept', async () => {
    const now = 1_000_000;
    const info = runner('m', { node: 'a' });
    const { k8s, r } = setup([info], () => now);
    k8s.nodes = [NODE('a'), NODE('b')];
    signIn(k8s, 'm');
    await r.reconcileAll();
    info.node = 'b';
    const held = await r.reconcileAll();
    expect(held[0]).toMatchObject({ held: 'b', moving: false, node: 'a' });
    expect(k8s.store.has(`PersistentVolumeClaim/bots/${namesFor('m').work}`)).toBe(true);
    expect((dep(k8s, 'm').metadata.annotations as Record<string, string>)['manythreads.io/move-held']).toBe('b');

    for (const c of [namesFor('m').state, namesFor('m').work]) {
      const claim = k8s.store.get(`PersistentVolumeClaim/bots/${c}`)!;
      claim.metadata.annotations = { ...claim.metadata.annotations, 'manythreads.io/move-confirmed': confirmMark('b', now) };
    }
    const moved = await r.reconcileAll();
    expect(moved[0]).toMatchObject({ moving: true, replicas: 0, state: 'moving' });
    expect(k8s.store.has(`PersistentVolumeClaim/bots/${namesFor('m').work}`)).toBe(false);
    expect(k8s.store.has(`PersistentVolumeClaim/bots/${namesFor('m').state}`)).toBe(false);
    expect(k8s.store.has(`Secret/bots/${namesFor('m').key}`)).toBe(true);
    expect(k8s.store.has(`Secret/bots/${namesFor('m').credentials}`)).toBe(true);
    const after = await r.reconcileAll();
    expect(after[0]).toMatchObject({ moving: false, node: 'b' });
    expect(k8s.store.get(`PersistentVolumeClaim/bots/${namesFor('m').work}`)!.metadata.annotations).toEqual({ 'manythreads.io/node': 'b' });
  });

  it('does not delete a volume when the confirmation is old or the target machine is not Ready', async () => {
    let now = 1_000_000; // moved forward below
    const info = runner('o', { node: 'a' });
    const { k8s, r } = setup([info], () => now);
    k8s.nodes = [NODE('a'), NODE('b', false)];
    await r.reconcileAll();
    info.node = 'b';
    for (const c of [namesFor('o').state, namesFor('o').work]) {
      const claim = k8s.store.get(`PersistentVolumeClaim/bots/${c}`)!;
      claim.metadata.annotations = { ...claim.metadata.annotations, 'manythreads.io/move-confirmed': confirmMark('b', now) };
    }
    await r.reconcileAll();
    expect(k8s.store.has(`PersistentVolumeClaim/bots/${namesFor('o').work}`)).toBe(true);
    k8s.nodes = [NODE('a'), NODE('b')];
    now += 16 * 60_000;
    await r.reconcileAll();
    expect(k8s.store.has(`PersistentVolumeClaim/bots/${namesFor('o').work}`)).toBe(true);
  });
});

describe('what the page is told', () => {
  it('never says ready before there is a sign-in file and a running container', () => {
    const base = { hasCredentials: true, hasBots: true, enabled: true, moving: false, held: null, pending: false, unschedulable: false, running: false };
    expect(stateFor({ ...base, hasCredentials: false, running: true }).status).toBe('waiting_for_sign_in');
    expect(stateFor(base).status).toBe('starting');
    expect(stateFor({ ...base, running: true }).status).toBe('ready');
    expect(stateFor({ ...base, pending: true, unschedulable: true }).status).toBe('waiting_for_node');
    expect(stateFor({ ...base, held: 'b' }).status).toBe('waiting_for_node');
    expect(stateFor({ ...base, moving: true }).status).toBe('moving');
  });
});
