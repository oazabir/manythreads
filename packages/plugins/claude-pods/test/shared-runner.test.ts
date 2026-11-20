/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed JSON documents whose shape the assertions then pin */
import type { PluginLogger, PodRunnerInfo, PodRunnerState } from '@manythreads/sdk';
import { confirmMark, type K8s, type K8sObject } from '@manythreads/sdk/pods';
import { describe, expect, it } from 'vitest';
import { configFrom, type ClaudePodConfig } from '../src/config.ts';
import { providerFor } from '../src/index.ts';
import { Reconciler, type RunnerSource } from '../src/reconcile.ts';
import { namesFor, podBaseFor, publisherKey, type PodRunner } from '../src/render.ts';

// P26-21 (agents-anywhere §9b): several teams share one runner (one sign-in, one subscription), kept apart by one pod per (runner, team). The runner's `state` volume, sign-in Secret and keeper
// identity are shared; the Deployment, Service, bridge key, profiles, work volume, repository list, push mount and deploy login belong to one team.

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
    if (kind === 'Secret' && o['stringData']) return { ...o, data: Object.fromEntries(Object.entries(o['stringData'] as Record<string, string>).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
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
  all(kind: string): K8sObject[] {
    return [...this.store.values()].filter((o) => o.kind === kind);
  }
  snapshot(): string {
    return JSON.stringify([...this.store.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

const CFG: ClaudePodConfig = { ...configFrom({}), namespace: 'bots', image: 'manythreads/claude-pod:1', serverUrl: 'http://manythreads-server.manythreads.svc:3000', repoOriginAllow: ['https://github.com/acme/'] };
const logs: string[] = [];
const LOG: PluginLogger = { info: (m) => void logs.push(m), warn: (m) => void logs.push(`WARN ${m}`) };

const ENG = { id: 't-eng', slug: 'engineering' };
const MKT = { id: 't-mkt', slug: 'marketing' };
const botsOf = (team: typeof ENG, ...bots: string[]) => bots.map((b) => ({ teamId: team.id, teamSlug: team.slug, botSlug: b }));

const runner = (name: string, agent: 'claude' | 'codex', over: Partial<PodRunnerInfo> = {}): PodRunner => ({
  id: `00000000-0000-4000-8000-${name.replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12)}`,
  workspaceId: 'w1',
  name,
  enabled: true,
  node: null,
  maxConcurrent: null,
  teams: [ENG, MKT],
  allTeams: false,
  bots: [...botsOf(ENG, 'engineer', 'deployer'), ...botsOf(MKT, 'writer', 'deployer')],
  agent,
  ...over,
});

function setup(runners: PodRunner[], over: Partial<RunnerSource> = {}, doFetch: typeof fetch = (async () => new Response('', { status: 503 })) as typeof fetch) {
  const k8s = new FakeK8s();
  const reports: PodRunnerState[] = [];
  const source: RunnerSource = {
    runners: async () => runners,
    report: async (s) => void reports.push(s),
    reposForTeams: async () => [
      { teamSlug: 'engineering', name: 'app', origin: 'https://github.com/acme/app.git', branch: 'main' },
      { teamSlug: 'marketing', name: 'site', origin: 'https://github.com/acme/site.git', branch: 'main' },
    ],
    publishersForTeams: async () => [
      { teamSlug: 'engineering', botSlug: 'engineer' },
      { teamSlug: 'marketing', botSlug: 'writer' },
    ],
    deployerKubeconfig: async (team) => ({ secret: `hermes-${team.slug}-deployer`, key: 'deployer.kubeconfig' }),
    ...over,
  };
  let n = 0;
  return { k8s, reports, source, r: new Reconciler(k8s, CFG, source, LOG, () => `key-${++n}`.padEnd(48, '0'), () => 1_000_000, doFetch) };
}
const base = (name: string, team: string, agent: 'claude' | 'codex' = 'claude'): string => namesFor(name, agent, team).base;
const dep = (k8s: FakeK8s, name: string, team: string, agent: 'claude' | 'codex' = 'claude'): any => k8s.store.get(`Deployment/bots/${base(name, team, agent)}`)!;
const configOf = (k8s: FakeK8s, name: string, team: string, agent: 'claude' | 'codex' = 'claude'): any => JSON.parse(((k8s.store.get(`ConfigMap/bots/${namesFor(name, agent, team).config}`) as any).data as any)['config.json']);
const podRunning = (k8s: FakeK8s, podBase: string): void => {
  k8s.store.set(`Pod/bots/${podBase}-1`, { apiVersion: 'v1', kind: 'Pod', metadata: { name: `${podBase}-1`, namespace: 'bots', labels: { 'manythreads.io/pod': podBase, 'manythreads.io/runner-id': 'x' } }, status: { phase: 'Running' } });
};

describe('two teams on one runner', () => {
  it('make one Deployment per team, one shared state claim, and separate work claims, keys, profiles and Services', async () => {
    const { k8s, r } = setup([runner('shared', 'claude')]);
    const res = await r.reconcileAll();
    expect(res).toHaveLength(1);
    expect(res[0]!.pods).toEqual(['claude-shared-engineering', 'claude-shared-marketing']);
    expect(k8s.all('Deployment').map((d) => d.metadata.name).sort()).toEqual(['claude-shared-engineering', 'claude-shared-marketing']);
    expect(k8s.all('Service').map((d) => d.metadata.name).sort()).toEqual(['claude-shared-engineering', 'claude-shared-marketing']);
    // one state claim for the runner, one work claim per team
    expect(k8s.all('PersistentVolumeClaim').map((c) => c.metadata.name).sort()).toEqual(['claude-shared-engineering-work', 'claude-shared-marketing-work', 'claude-shared-state']);
    // every pod mounts that one state claim and its own work claim
    const claims = (team: string): Record<string, string> => Object.fromEntries(dep(k8s, 'shared', team).spec.template.spec.volumes.filter((v: any) => v.persistentVolumeClaim).map((v: any) => [v.name, v.persistentVolumeClaim.claimName]));
    expect(claims('engineering')).toEqual({ state: 'claude-shared-state', work: 'claude-shared-engineering-work' });
    expect(claims('marketing')).toEqual({ state: 'claude-shared-state', work: 'claude-shared-marketing-work' });
    // separate bridge keys (drawn once each), configs and bridge state folders
    const keyOf = (team: string): string => dep(k8s, 'shared', team).spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name;
    expect(keyOf('engineering')).toBe('claude-shared-engineering-key');
    expect(keyOf('marketing')).toBe('claude-shared-marketing-key');
    const k = (team: string): string => Buffer.from(((k8s.store.get(`Secret/bots/${keyOf(team)}`) as any).stringData as any)['api-key']).toString();
    expect(k('engineering')).not.toBe(k('marketing'));
    expect(Object.keys(configOf(k8s, 'shared', 'engineering').profiles).sort()).toEqual(['engineering--deployer', 'engineering--engineer']);
    expect(Object.keys(configOf(k8s, 'shared', 'marketing').profiles).sort()).toEqual(['marketing--deployer', 'marketing--writer']);
    const cmd = (team: string): string[] => dep(k8s, 'shared', team).spec.template.spec.containers[0].command;
    expect(cmd('engineering')).toContain('/state/bridge/engineering');
    expect(cmd('marketing')).toContain('/state/bridge/marketing');
    // both Services select their own pod only
    expect((k8s.store.get('Service/bots/claude-shared-marketing') as any).spec.selector).toEqual({ 'manythreads.io/pod': 'claude-shared-marketing' });
    // concurrency is per team pod: each bridge carries the runner's limit by itself
    expect(configOf(k8s, 'shared', 'engineering').maxConcurrentRuns).toBe(2);
    expect(configOf(k8s, 'shared', 'marketing').maxConcurrentRuns).toBe(2);
    // a second pass changes nothing
    const first = k8s.snapshot();
    await r.reconcileAll();
    expect(k8s.snapshot()).toBe(first);
  });

  it('gives team B\'s pod no profile, key, push token, deploy login, repository, home or work volume of team A', async () => {
    const { k8s, r } = setup([runner('shared', 'claude')]);
    await r.reconcileAll();
    const b = dep(k8s, 'shared', 'marketing');
    const bText = JSON.stringify([b, k8s.store.get(`ConfigMap/bots/${namesFor('shared', 'claude', 'marketing').config}`), k8s.store.get(`Service/bots/claude-shared-marketing`)]);
    for (const needle of ['engineering', 'hermes-engineering', 't-eng', 'engineer', 'claude-shared-engineering']) expect(bText, needle).not.toContain(needle);
    // team B's own things are there
    expect(bText).toContain('hermes-marketing-push');
    expect(bText).toContain('hermes-marketing-deployer');
    expect(bText).toContain('https://github.com/acme/site.git');
    expect(bText).not.toContain('acme/app.git');
    // team B's pod does not hold team A's bridge key
    const keyA = Buffer.from(((k8s.store.get('Secret/bots/claude-shared-engineering-key') as any).stringData as any)['api-key']).toString();
    expect(bText).not.toContain(keyA);
    // and the same the other way round
    const aText = JSON.stringify([dep(k8s, 'shared', 'engineering'), k8s.store.get(`ConfigMap/bots/${namesFor('shared', 'claude', 'engineering').config}`)]);
    for (const needle of ['marketing', 'hermes-marketing', 't-mkt', 'writer', 'site.git']) expect(aText, needle).not.toContain(needle);
    // the push and deploy Secret volumes: exactly one team's, in the right container only
    const secrets = (d: any): string[] => d.spec.template.spec.volumes.filter((v: any) => v.secret).map((v: any) => v.secret.secretName).sort();
    expect(secrets(b)).toEqual(['hermes-marketing-deployer', 'hermes-marketing-push']);
    expect(secrets(dep(k8s, 'shared', 'engineering'))).toEqual(['hermes-engineering-deployer', 'hermes-engineering-push']);
    const mounts = b.spec.template.spec.containers.flatMap((c: any) => c.volumeMounts.map((m: any) => `${c.name}:${m.mountPath}`)).filter((m: string) => /deployer|publisher-push/.test(m));
    expect(mounts.sort()).toEqual(['bridge:/etc/deployer/marketing', 'publisher:/etc/publisher-push/marketing']);
    // the deployer bot of each team holds that team's kubeconfig only
    expect(configOf(k8s, 'shared', 'marketing').profiles['marketing--deployer'].env.KUBECONFIG).toBe('/etc/deployer/marketing/deployer.kubeconfig');
    expect(configOf(k8s, 'shared', 'engineering').profiles['engineering--deployer'].env.KUBECONFIG).toBe('/etc/deployer/engineering/deployer.kubeconfig');
    // the pods only reach the cluster API with their own label, and no keeper exists without an uploaded file
    expect(b.spec.template.metadata.labels['manythreads.io/kube-api']).toBe('true');
    expect(b.spec.template.metadata.labels['manythreads.io/team']).toBe('marketing');
  });

  it('keeps one team\'s pod running when another team has no bot left on the runner, stopping only the pod of the team that left', async () => {
    const info = runner('shared', 'claude');
    const { k8s, r } = setup([info]);
    await r.reconcileAll();
    expect(dep(k8s, 'shared', 'marketing').spec.replicas).toBe(1);
    info.bots = botsOf(ENG, 'engineer');
    await r.reconcileAll();
    expect(dep(k8s, 'shared', 'engineering').spec.replicas).toBe(1);
    expect(dep(k8s, 'shared', 'marketing').spec.replicas).toBe(0);
    // volumes and keys of the team that left are kept
    expect(k8s.store.has('PersistentVolumeClaim/bots/claude-shared-marketing-work')).toBe(true);
    expect(k8s.store.has('Secret/bots/claude-shared-marketing-key')).toBe(true);
  });

  it('is ready when the shared sign-in is good, asked through any running team pod, with that pod\'s own key', async () => {
    const seen: { url: string; auth: string }[] = [];
    // only the marketing pod runs and answers; the engineering pod is not up yet
    const doFetch = (async (url: string, init: RequestInit) => (seen.push({ url, auth: String((init.headers as Record<string, string>)['authorization']) }), new Response(JSON.stringify({ auth: { state: 'signed_in' } }), { status: 200 }))) as unknown as typeof fetch;
    const { k8s, reports, r } = setup([runner('shared', 'claude')], {}, doFetch);
    await r.reconcileAll();
    podRunning(k8s, 'claude-shared-marketing');
    const res = await r.reconcileAll();
    expect(res[0]!.state).toBe('ready');
    expect(reports.at(-1)!.status).toBe('ready');
    const status = seen.filter((s) => s.url.includes('/v1/auth/status'));
    expect(status).toHaveLength(1);
    expect(status[0]!.url).toBe('http://claude-shared-marketing.bots.svc:8650/v1/auth/status?agent=claude-code');
    const keyB = Buffer.from(((k8s.store.get('Secret/bots/claude-shared-marketing-key') as any).stringData as any)['api-key']).toString();
    expect(status[0]!.auth).toBe(`Bearer ${keyB}`);
    // each running pod is sent its own team's repositories only
    const puts = seen.filter((s) => s.url.endsWith('/internal/repos'));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain('claude-shared-marketing');
  });

  it('waits for a sign-in while no pod says signed in (the sign-in is not any one pod\'s)', async () => {
    const out = (async () => new Response(JSON.stringify({ auth: { state: 'signed_out' } }), { status: 200 })) as unknown as typeof fetch;
    const { k8s, r } = setup([runner('shared', 'claude')], {}, out);
    await r.reconcileAll();
    podRunning(k8s, 'claude-shared-engineering');
    podRunning(k8s, 'claude-shared-marketing');
    expect((await r.reconcileAll())[0]!.state).toBe('waiting_for_sign_in');
  });

  it('sends each team pod the repositories of its own team and no other', async () => {
    const puts: { url: string; repos: any[] }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/internal/repos')) puts.push({ url: String(url), repos: JSON.parse(String(init.body)).repos });
      return new Response(JSON.stringify({ auth: { state: 'signed_in' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { k8s, r } = setup([runner('shared', 'claude')], {}, doFetch);
    await r.reconcileAll();
    podRunning(k8s, 'claude-shared-engineering');
    podRunning(k8s, 'claude-shared-marketing');
    await r.reconcileAll();
    const by = (team: string): any[] => puts.find((p) => p.url.includes(`claude-shared-${team}`))!.repos;
    expect(by('engineering').map((x) => `${x.team}/${x.project}`)).toEqual(['engineering/app', 'engineering/app']);
    expect(by('marketing').map((x) => `${x.team}/${x.project}`)).toEqual(['marketing/site', 'marketing/site']);
  });

  it('runs the keeper in one pod only when there is an uploaded sign-in file, and every pod copies the file into the shared state volume', async () => {
    const { k8s, r } = setup([runner('shared', 'claude')]);
    const n = namesFor('shared');
    k8s.store.set(`Secret/bots/${n.credentials}`, { apiVersion: 'v1', kind: 'Secret', metadata: { name: n.credentials, namespace: 'bots' }, data: { '.credentials.json': 'eA==', 'upload-id': Buffer.from('up-1').toString('base64') } });
    await r.reconcileAll();
    const names = (team: string): string[] => dep(k8s, 'shared', team).spec.template.spec.containers.map((c: any) => c.name);
    expect(names('engineering')).toContain('keeper');
    expect(names('marketing')).not.toContain('keeper');
    for (const team of ['engineering', 'marketing']) {
      expect(dep(k8s, 'shared', team).spec.template.spec.volumes.map((v: any) => v.name)).toContain('creds');
      expect(dep(k8s, 'shared', team).spec.template.spec.initContainers[0].command[2]).toContain('/creds/.credentials.json');
    }
    // one set of rights for the keeper, for the runner's one sign-in Secret
    expect(k8s.all('Role')).toHaveLength(1);
  });
});

describe('full access per team pod', () => {
  it('is written into the profiles of every team pod of a Codex or Claude Code runner (no one-team limit), and only when the runner says so', async () => {
    const codex = setup([runner('cx', 'codex', { fullAccess: true })]);
    await codex.r.reconcileAll();
    for (const team of ['engineering', 'marketing']) {
      const profiles = Object.values(configOf(codex.k8s, 'cx', team, 'codex').profiles) as any[];
      expect(profiles.length).toBe(2);
      for (const p of profiles) expect(p.fullAccess).toBe(true);
      expect(profiles[0].instructions).toContain('without a question');
    }
    const off = setup([runner('cx', 'codex', { fullAccess: false })]);
    await off.r.reconcileAll();
    for (const p of Object.values(configOf(off.k8s, 'cx', 'engineering', 'codex').profiles) as any[]) expect(p.fullAccess).toBeUndefined();
    const claude = setup([runner('cl', 'claude', { fullAccess: true })]);
    await claude.r.reconcileAll();
    for (const team of ['engineering', 'marketing']) for (const p of Object.values(configOf(claude.k8s, 'cl', team).profiles) as any[]) expect(p.fullAccess).toBe(true);
    const claudeOff = setup([runner('cl', 'claude', { fullAccess: false })]);
    await claudeOff.r.reconcileAll();
    for (const p of Object.values(configOf(claudeOff.k8s, 'cl', 'engineering').profiles) as any[]) expect(p.fullAccess).toBeUndefined();
  });
});

describe('migrating the single pod a runner had before', () => {
  /** The objects of a runner as the old controller left them: one Deployment and Service `claude-<runner>`, one key, one config and the two claims. */
  function oldRunner(k8s: FakeK8s, info: PodRunner, running = true): void {
    const old = namesFor(info.name, info.agent === 'codex' ? 'codex' : 'claude');
    const labels = { 'app.kubernetes.io/name': 'manythreads', 'app.kubernetes.io/component': 'claude-pod', 'app.kubernetes.io/managed-by': 'manythreads-claude-pods', 'manythreads.io/runner': info.name, 'manythreads.io/runner-id': info.id };
    const put = (kind: string, name: string, extra: Record<string, unknown> = {}): void => void k8s.store.set(`${kind}/bots/${name}`, { apiVersion: 'v1', kind, metadata: { name, namespace: 'bots', labels }, ...extra });
    put('Deployment', old.base, { spec: { replicas: running ? 1 : 0, template: {} } });
    put('Service', old.base);
    put('ConfigMap', old.config);
    put('Secret', old.key, { stringData: { 'api-key': 'old-key' } });
    put('PersistentVolumeClaim', old.state);
    put('PersistentVolumeClaim', old.work, { spec: { resources: { requests: { storage: '20Gi' } } } });
    if (running) k8s.store.set(`Pod/bots/${old.base}-x`, { apiVersion: 'v1', kind: 'Pod', metadata: { name: `${old.base}-x`, namespace: 'bots', labels: { ...labels, 'manythreads.io/pod': old.base } }, status: { phase: 'Running' } });
  }

  it('stops the old pod first, then starts a pod per team; the old work volume becomes the first team\'s and nothing is deleted but the old key', async () => {
    const info = runner('shared', 'claude');
    const { k8s, r } = setup([info]);
    oldRunner(k8s, info);
    const claimsBefore = k8s.all('PersistentVolumeClaim').map((c) => c.metadata.name).sort();

    // pass 1: the old pod is scaled to zero; the team pods exist but wait (two pods never write one volume)
    await r.reconcileAll();
    expect((k8s.store.get('Deployment/bots/claude-shared') as any).spec.replicas).toBe(0);
    expect(dep(k8s, 'shared', 'engineering').spec.replicas).toBe(0);
    expect(dep(k8s, 'shared', 'marketing').spec.replicas).toBe(0);
    expect(k8s.store.has('Secret/bots/claude-shared-key')).toBe(true);
    // the first team (by slug) takes the old work volume, without a copy or a rename; the claim is labelled so the choice stays
    expect(dep(k8s, 'shared', 'engineering').spec.template.spec.volumes.find((v: any) => v.name === 'work').persistentVolumeClaim.claimName).toBe('claude-shared-work');
    expect(dep(k8s, 'shared', 'marketing').spec.template.spec.volumes.find((v: any) => v.name === 'work').persistentVolumeClaim.claimName).toBe('claude-shared-marketing-work');
    expect(k8s.store.get('PersistentVolumeClaim/bots/claude-shared-work')!.metadata.labels!['manythreads.io/team-id']).toBe('t-eng');

    // pass 2: the old pod is gone: the team pods start, the old key goes with the old pod
    k8s.store.delete('Pod/bots/claude-shared-x');
    await r.reconcileAll();
    expect(dep(k8s, 'shared', 'engineering').spec.replicas).toBe(1);
    expect(dep(k8s, 'shared', 'marketing').spec.replicas).toBe(1);
    expect(k8s.store.has('Secret/bots/claude-shared-key')).toBe(false);
    // no claim was deleted: the state claim and the old work claim are the same objects, the second team's work claim is new
    const after = k8s.all('PersistentVolumeClaim').map((c) => c.metadata.name).sort();
    expect(after).toEqual([...claimsBefore, 'claude-shared-marketing-work'].sort());
    expect(logs.join('\n')).toMatch(/single pod of this runner is stopped/);

    // further passes change nothing, and the choice of the first team sticks when another team sorts earlier
    const stable = k8s.snapshot();
    await r.reconcileAll();
    expect(k8s.snapshot()).toBe(stable);
    info.bots = [...botsOf({ id: 't-art', slug: 'art' }, 'painter'), ...info.bots];
    info.teams = [{ id: 't-art', slug: 'art' }, ...info.teams];
    await r.reconcileAll();
    expect(dep(k8s, 'shared', 'engineering').spec.template.spec.volumes.find((v: any) => v.name === 'work').persistentVolumeClaim.claimName).toBe('claude-shared-work');
    expect(dep(k8s, 'shared', 'art').spec.template.spec.volumes.find((v: any) => v.name === 'work').persistentVolumeClaim.claimName).toBe('claude-shared-art-work');
  });

  it('keeps the old pod\'s state volume (the sign-in) as the runner\'s shared one, and a runner with one team keeps working the same way', async () => {
    const info = runner('solo', 'codex', { teams: [ENG], bots: botsOf(ENG, 'engineer') });
    const { k8s, r } = setup([info]);
    oldRunner(k8s, info, false);
    await r.reconcileAll();
    const d = dep(k8s, 'solo', 'engineering', 'codex');
    expect(d.spec.replicas).toBe(1);
    expect(d.spec.template.spec.volumes.find((v: any) => v.name === 'state').persistentVolumeClaim.claimName).toBe('codex-solo-state');
    expect(d.spec.template.spec.volumes.find((v: any) => v.name === 'work').persistentVolumeClaim.claimName).toBe('codex-solo-work');
  });

  it('leaves an old object alone that belongs to another runner (two plain names that spell the same)', async () => {
    // runner `a-b` with its single pod `claude-a-b`, and runner `a` with a team `b`: the pod name of the second pair is the first runner's pod
    const first = runner('a-b', 'claude', { teams: [ENG], bots: botsOf(ENG, 'engineer') });
    const second = runner('a', 'claude', { teams: [{ id: 't-b', slug: 'b' }], bots: botsOf({ id: 't-b', slug: 'b' }, 'worker') });
    const { k8s, r } = setup([first, second]);
    oldRunner(k8s, first, false);
    const before = JSON.stringify(k8s.store.get('Deployment/bots/claude-a-b'));
    await r.reconcileAll();
    expect(JSON.stringify(k8s.store.get('Deployment/bots/claude-a-b'))).toBe(before);
    expect(logs.join('\n')).toMatch(/no pod is made for team b: Deployment claude-a-b belongs to another runner/);
  });
});

describe('moving a runner', () => {
  const NODE = (name: string): K8sObject => ({ apiVersion: 'v1', kind: 'Node', metadata: { name, labels: { 'kubernetes.io/hostname': name } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
  const claim = (k8s: FakeK8s, name: string): K8sObject => k8s.store.get(`PersistentVolumeClaim/bots/${name}`)!;

  it('moves every team pod together: all pods stop, then the shared state volume and every work volume are made again; the Secrets stay', async () => {
    const now = 1_000_000;
    const info = runner('shared', 'claude', { node: 'a' });
    const { k8s, r } = setup([info]);
    k8s.nodes = [NODE('a'), NODE('b')];
    await r.reconcileAll();
    info.node = 'b';
    const held = await r.reconcileAll();
    expect(held[0]).toMatchObject({ held: 'b', moving: false, node: 'a' });
    for (const team of ['engineering', 'marketing']) expect(dep(k8s, 'shared', team).metadata.annotations['manythreads.io/move-held']).toBe('b');
    for (const c of ['claude-shared-state', 'claude-shared-engineering-work', 'claude-shared-marketing-work']) {
      claim(k8s, c).metadata.annotations = { ...claim(k8s, c).metadata.annotations, 'manythreads.io/move-confirmed': confirmMark('b', now) };
    }
    const moving = await r.reconcileAll();
    expect(moving[0]).toMatchObject({ moving: true, replicas: 0 });
    expect(k8s.all('PersistentVolumeClaim')).toHaveLength(0);
    for (const team of ['engineering', 'marketing']) expect(dep(k8s, 'shared', team).spec.replicas).toBe(0);
    expect(k8s.store.has('Secret/bots/claude-shared-engineering-key')).toBe(true);
    expect(k8s.store.has('Secret/bots/claude-shared-marketing-key')).toBe(true);
    const after = await r.reconcileAll();
    expect(after[0]).toMatchObject({ moving: false, node: 'b' });
    expect(k8s.all('PersistentVolumeClaim').map((c) => c.metadata.annotations)).toEqual([{ 'manythreads.io/node': 'b' }, { 'manythreads.io/node': 'b' }, { 'manythreads.io/node': 'b' }]);
    for (const team of ['engineering', 'marketing']) expect(dep(k8s, 'shared', team).spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'b' });
  });

  it('waits for the pods of every team to stop before it deletes a volume', async () => {
    const now = 1_000_000;
    const info = runner('shared', 'claude', { node: 'a' });
    const { k8s, r } = setup([info]);
    k8s.nodes = [NODE('a'), NODE('b')];
    await r.reconcileAll();
    info.node = 'b';
    await r.reconcileAll();
    for (const c of ['claude-shared-state', 'claude-shared-engineering-work', 'claude-shared-marketing-work']) {
      claim(k8s, c).metadata.annotations = { ...claim(k8s, c).metadata.annotations, 'manythreads.io/move-confirmed': confirmMark('b', now) };
    }
    // the marketing pod is still terminating: nothing is deleted
    k8s.store.set('Pod/bots/claude-shared-marketing-1', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'claude-shared-marketing-1', namespace: 'bots', labels: { 'manythreads.io/pod': 'claude-shared-marketing', 'manythreads.io/runner-id': info.id } }, status: { phase: 'Running' } });
    await r.reconcileAll();
    expect(k8s.all('PersistentVolumeClaim')).toHaveLength(3);
    k8s.store.delete('Pod/bots/claude-shared-marketing-1');
    await r.reconcileAll();
    expect(k8s.all('PersistentVolumeClaim')).toHaveLength(0);
  });

  it('pins several team pods to the machine the shared volumes are on, so they can all mount the one state volume', async () => {
    const info = runner('shared', 'claude');
    const { k8s, r } = setup([info]);
    await r.reconcileAll();
    expect(dep(k8s, 'shared', 'engineering').spec.template.spec.nodeSelector).toBeUndefined();
    // the scheduler put the state volume on a machine
    const state = claim(k8s, 'claude-shared-state');
    state.metadata.annotations = { ...state.metadata.annotations, 'manythreads.io/node': 'vm-1' };
    await r.reconcileAll();
    for (const team of ['engineering', 'marketing']) expect(dep(k8s, 'shared', team).spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'vm-1' });
    // a team added later gets its claim on the same machine and its pod on it
    info.bots = [...info.bots, ...botsOf({ id: 't-ops', slug: 'ops' }, 'runner')];
    await r.reconcileAll();
    expect(dep(k8s, 'shared', 'ops').spec.template.spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'vm-1' });
    expect(claim(k8s, 'claude-shared-ops-work').metadata.annotations).toEqual({ 'manythreads.io/node': 'vm-1' });
  });
});

describe('the bridge a run or a sign-in is sent to', () => {
  const runnerLabels = (name: string): Record<string, string> => ({ 'app.kubernetes.io/component': 'claude-pod', 'app.kubernetes.io/managed-by': 'manythreads-claude-pods', 'manythreads.io/runner': name });
  const provider = (k8s: FakeK8s) => providerFor(() => ({}) as Reconciler, () => k8s, CFG);
  let rec: Reconciler | null = null;
  const withTwoPods = async (): Promise<FakeK8s> => {
    const { k8s, r } = setup([runner('shared', 'claude')]);
    await r.reconcileAll();
    rec = r;
    return k8s;
  };
  /** The controller keeps a key as `stringData`; the cluster hands it back as `data`: make the stored one say what the test wants. */
  const setKey = (k8s: FakeK8s, name: string, value: string): void => {
    const s = k8s.store.get(`Secret/bots/${name}`) as any;
    delete s.stringData;
    s.data = { 'api-key': Buffer.from(value).toString('base64') };
  };

  it('sends a run to the pod of its own team: address and key are that pod\'s', async () => {
    const k8s = await withTwoPods();
    const keyOf = (team: string): string => Buffer.from(((k8s.store.get(`Secret/bots/claude-shared-${team}-key`) as any).stringData as any)['api-key']).toString();
    const keys = { engineering: keyOf('engineering'), marketing: keyOf('marketing') };
    for (const t of ['engineering', 'marketing']) setKey(k8s, `claude-shared-${t}-key`, keys[t as 'engineering']);
    const p = provider(k8s);
    expect(await p.bridge({ runnerName: 'shared', agent: 'claude', teamSlug: 'marketing' })).toEqual({ address: 'http://claude-shared-marketing.bots.svc:8650', key: keys.marketing });
    expect(await p.bridge({ runnerName: 'shared', agent: 'claude', teamSlug: 'engineering' })).toEqual({ address: 'http://claude-shared-engineering.bots.svc:8650', key: keys.engineering });
    // a team with no pod gets none (it never falls back to another team's pod)
    expect(await p.bridge({ runnerName: 'shared', agent: 'claude', teamSlug: 'sales' })).toBeNull();
  });

  it('answers the runner\'s sign-in through any one live team pod: the first running one by name, else the first with a key', async () => {
    const k8s = await withTwoPods();
    for (const t of ['engineering', 'marketing']) {
      setKey(k8s, `claude-shared-${t}-key`, `k-${t}`);
    }
    // an old single pod of the runner (no team label) is never the answer
    k8s.store.set('Deployment/bots/claude-shared', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'claude-shared', namespace: 'bots', labels: runnerLabels('shared') } });
    const p = provider(k8s);
    // none running: the first by name still answers (its pod may be starting)
    expect(await p.bridge({ runnerName: 'shared', agent: 'claude' })).toEqual({ address: 'http://claude-shared-engineering.bots.svc:8650', key: 'k-engineering' });
    // only marketing runs: it answers, and keeps answering as long as it runs (the steps of one sign-in meet one pod)
    podRunning(k8s, 'claude-shared-marketing');
    expect(await p.bridge({ runnerName: 'shared', agent: 'claude' })).toEqual({ address: 'http://claude-shared-marketing.bots.svc:8650', key: 'k-marketing' });
    expect(await p.bridge({ runnerName: 'shared', agent: 'claude' })).toEqual({ address: 'http://claude-shared-marketing.bots.svc:8650', key: 'k-marketing' });
    // a Codex runner of the same name is not asked, and a runner that does not exist has no answer
    expect(await p.bridge({ runnerName: 'shared', agent: 'codex' })).toBeNull();
    expect(await p.bridge({ runnerName: 'nobody', agent: 'claude' })).toBeNull();
  });

  it('checks the saved sign-in through any pod', async () => {
    const k8s = await withTwoPods();
    setKey(k8s, 'claude-shared-marketing-key', 'k');
    const asked: string[] = [];
    const doFetch = (async (url: string) => (asked.push(String(url)), new Response(JSON.stringify({ result: 'ok' }), { status: 200 }))) as unknown as typeof fetch;
    const p = providerFor(() => ({}) as Reconciler, () => k8s, CFG, Date.now, doFetch);
    podRunning(k8s, 'claude-shared-marketing');
    expect(await p.checkSignin({ runnerName: 'shared', agent: 'claude' })).toBe('ok');
    expect(asked).toEqual(['http://claude-shared-marketing.bots.svc:8650/v1/signin/check']);
  });

  it('says one thing about all the runner\'s pods: pending when one is pending, the state volume\'s machine, moving or held when any pod is', async () => {
    const k8s = await withTwoPods();
    const info = runner('shared', 'claude');
    const p = providerFor(() => rec!, () => k8s, CFG);
    expect(await p.podPlacements({ runnerIds: [info.id] })).toEqual([expect.objectContaining({ runnerId: info.id, phase: 'absent', moving: false, moveHeld: false })]);
    podRunning(k8s, 'claude-shared-engineering');
    const dep2 = k8s.store.get('Deployment/bots/claude-shared-marketing')!;
    dep2.metadata.annotations = { 'manythreads.io/move-held': 'b' };
    k8s.store.set('Pod/bots/claude-shared-marketing-1', { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'claude-shared-marketing-1', namespace: 'bots', labels: { 'manythreads.io/pod': 'claude-shared-marketing' } }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] } });
    const state = k8s.store.get('PersistentVolumeClaim/bots/claude-shared-state')!;
    state.metadata.annotations = { 'manythreads.io/node': 'vm-1' };
    expect(await p.podPlacements({ runnerIds: [info.id] })).toEqual([{ runnerId: info.id, phase: 'pending', node: null, volumeNode: 'vm-1', moving: false, moveHeld: true, pendingReason: 'unschedulable' }]);
    expect(await p.podPlacements({ runnerIds: ['other'] })).toEqual([]);
  });
});

describe('the names of a team pod', () => {
  it('are claude-<runner>-<team>, and stay valid Kubernetes names, distinct for distinct pairs, whatever the runner and team are called', () => {
    expect(podBaseFor('claude', 'shared', 'engineering')).toBe('claude-shared-engineering');
    expect(podBaseFor('codex', 'shared', 'engineering')).toBe('codex-shared-engineering');
    const long = podBaseFor('claude', 'r'.repeat(63), 't'.repeat(63));
    const long2 = podBaseFor('claude', 'r'.repeat(63), 't'.repeat(62) + 'u');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(long).not.toBe(long2);
    const odd = podBaseFor('claude', 'my.runner_1', 'ops-');
    expect(odd).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    for (const n of [long, long2, odd]) expect(`${n}-credentials`.length).toBeLessThan(253);
    // the runner's shared names do not carry the team
    expect(namesFor('shared', 'claude', 'engineering')).toMatchObject({ state: 'claude-shared-state', credentials: 'claude-shared-credentials', keeper: 'claude-shared-keeper' });
  });

  it('never gives a team pod the push key of another pod: two teams\' keys are different objects with different names', () => {
    const a = namesFor('shared', 'claude', 'engineering');
    const b = namesFor('shared', 'claude', 'marketing');
    for (const k of ['base', 'work', 'key', 'config'] as const) expect(a[k]).not.toBe(b[k]);
    for (const k of ['state', 'credentials', 'keeper'] as const) expect(a[k]).toBe(b[k]);
    expect(publisherKey('engineering', 'engineer')).not.toBe(publisherKey('marketing', 'engineer'));
  });
});
