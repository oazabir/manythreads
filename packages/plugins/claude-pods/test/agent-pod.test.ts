/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed JSON documents whose shape the assertions then pin */
import type { PluginLogger, PodRunnerInfo } from '@manythreads/sdk';
import type { K8s, K8sObject } from '@manythreads/sdk/pods';
import { describe, expect, it } from 'vitest';
import { configFrom, type ClaudePodConfig } from '../src/config.ts';
import { Reconciler, type RunnerSource } from '../src/reconcile.ts';
import { buildBridgeConfig, buildDeployment, kubeconfigPath, namesFor, publisherKey, runnerForTeam, type DeployPlan, type PodRunner } from '../src/render.ts';

// P26-09: the agent pod. Both agents run over ACP; the pod starts with no sign-in (the Runners page signs the agent in inside the pod); Codex has full access only when the runner says so,
// for one team; the team's deployer bot, and only it, gets the deploy login; nothing in the pod reaches the cluster API except a pod that needs it.

class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
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
    return [];
  }
}

const CFG: ClaudePodConfig = { ...configFrom({}), namespace: 'bots', image: 'manythreads/claude-pod:1', serverUrl: 'http://manythreads-server.manythreads.svc:3000', repoOriginAllow: ['https://github.com/acme/'] };
const LOGS: string[] = [];
const LOG: PluginLogger = { info: (m) => void LOGS.push(m), warn: (m) => void LOGS.push(`WARN ${m}`) };
const ENG = { teamId: 't-eng', teamSlug: 'engineering', botSlug: 'engineer' };
const DEP = { teamId: 't-eng', teamSlug: 'engineering', botSlug: 'deployer' };
const MKT = { teamId: 't-mkt', teamSlug: 'marketing', botSlug: 'deployer' };

const runner = (name: string, agent: 'claude' | 'codex', over: Partial<PodRunnerInfo> = {}): PodRunner => ({
  id: `00000000-0000-4000-8000-${name.replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12)}`,
  workspaceId: 'w1',
  name,
  enabled: true,
  node: null,
  maxConcurrent: null,
  teams: [{ id: 't-eng', slug: 'engineering' }],
  allTeams: false,
  bots: [ENG],
  agent,
  ...over,
});
const profilesOf = (r: PodRunner, deploy?: DeployPlan, cfg: ClaudePodConfig = CFG): Record<string, any> => JSON.parse(buildBridgeConfig(cfg, r, new Set(), deploy)).profiles;
const DEPLOY: DeployPlan = { bots: new Set([publisherKey('engineering', 'deployer')]), mounts: [{ teamSlug: 'engineering', secret: 'hermes-engineering-deployer', key: 'deployer.kubeconfig' }] };
const deployment = (r: PodRunner, opts: Partial<Parameters<typeof buildDeployment>[3]> = {}): any =>
  buildDeployment(CFG, r, namesFor(r.name, r.agent, 'engineering'), { replicas: 1, node: null, moving: false, held: null, uploadId: null, pushSecrets: [], profilesSha: 'x', keeper: false, deployMounts: [], ...opts });
const bridgeOf = (d: any): any => d.spec.template.spec.containers.find((c: any) => c.name === 'bridge');

describe('the bridge profiles of an agent pod', () => {
  it('drive Claude Code and Codex over ACP with their adapters and the folder the sign-in lives in', () => {
    const c = profilesOf(runner('c', 'claude'))['engineering--engineer'];
    expect(c).toMatchObject({ agent: 'claude-code', driver: 'acp', acp: { command: 'claude-agent-acp' }, authHome: '/state/claude' });
    const x = profilesOf(runner('x', 'codex'))['engineering--engineer'];
    expect(x).toMatchObject({ agent: 'codex', driver: 'acp', acp: { command: 'codex-acp' }, authHome: '/state/codex' });
    // what a bot needs to test and check a page: a pnpm store in the work volume, and the browsers the image carries
    expect(c.env).toMatchObject({ npm_config_store_dir: '/work/.pnpm-store', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' });
  });

  it('are the older command-line shape when the stand-in image is used (no adapter, no sign-in folder)', () => {
    const p = profilesOf(runner('c', 'claude'), undefined, { ...CFG, driver: 'cli' })['engineering--engineer'];
    expect(p.driver).toBeUndefined();
    expect(p.acp).toBeUndefined();
    expect(p.authHome).toBeUndefined();
  });

  it('write one placeholder profile when no bot is placed yet, so the sign-in works before there is a bot', () => {
    const p = profilesOf(runner('c', 'claude', { bots: [] }));
    expect(Object.keys(p)).toEqual(['default']);
    expect(p['default']).toMatchObject({ agent: 'claude-code', driver: 'acp', workdir: '/work' });
  });

  it('give Codex and Claude Code full access only when the runner says so, on every team pod (P35-01)', () => {
    expect(profilesOf(runner('x', 'codex'))['engineering--engineer'].fullAccess).toBeUndefined();
    const on = profilesOf(runner('x', 'codex', { fullAccess: true }))['engineering--engineer'];
    expect(on.fullAccess).toBe(true);
    expect(on.instructions).toContain('without a question');
    const claude = profilesOf(runner('c', 'claude', { fullAccess: true }))['engineering--engineer'];
    expect(claude.fullAccess).toBe(true);
    expect(claude.instructions).toContain('Your commands run without a question in this pod');
    expect(profilesOf(runner('c', 'claude'))['engineering--engineer'].fullAccess).toBeUndefined();
    expect(profilesOf(runner('c', 'claude'))['engineering--engineer'].instructions).not.toContain('without a question');
    expect(profilesOf(runner('c', 'claude', { fullAccess: true }), undefined, { ...CFG, driver: 'cli' })['engineering--engineer'].fullAccess).toBeUndefined();
    // two teams on one runner: each team has a pod of its own, and full access applies to each team pod (agents-anywhere §9b)
    const wide = runner('x', 'codex', { fullAccess: true, allTeams: true, bots: [ENG, { teamId: 't-mkt', teamSlug: 'marketing', botSlug: 'writer' }] });
    for (const team of [{ id: 't-eng', slug: 'engineering' }, { id: 't-mkt', slug: 'marketing' }]) {
      const mine = profilesOf(runnerForTeam(wide, team));
      expect(Object.keys(mine).every((k) => k.startsWith(`${team.slug}--`))).toBe(true);
      for (const p of Object.values(mine)) expect(p.fullAccess).toBe(true);
    }
    // the stand-in image has no ACP driver: the key is not written
    expect(profilesOf(runner('x', 'codex', { fullAccess: true }), undefined, { ...CFG, driver: 'cli' })['engineering--engineer'].fullAccess).toBeUndefined();
  });

  it('hand the deploy login (KUBECONFIG) to the deployer bot only, and say where it is', () => {
    const r = runner('c', 'claude', { bots: [ENG, DEP] });
    const p = profilesOf(r, DEPLOY);
    expect(p['engineering--deployer'].env.KUBECONFIG).toBe(kubeconfigPath('engineering', 'deployer.kubeconfig'));
    expect(p['engineering--deployer'].instructions).toContain(kubeconfigPath('engineering', 'deployer.kubeconfig'));
    expect(p['engineering--engineer'].env.KUBECONFIG).toBeUndefined();
    expect(p['engineering--engineer'].instructions).not.toContain('deployer.kubeconfig');
    // same for Codex
    const x = profilesOf(runner('x', 'codex', { bots: [ENG, DEP] }), DEPLOY);
    expect(x['engineering--deployer'].env.KUBECONFIG).toBeDefined();
    expect(x['engineering--engineer'].env.KUBECONFIG).toBeUndefined();
    // no plan, no variable anywhere
    for (const prof of Object.values(profilesOf(r))) expect(JSON.stringify(prof)).not.toContain('KUBECONFIG');
  });

  it('allow the two record commands for Claude Code in a pod that runs ACP, and tell the bots how to carry a branch', () => {
    const p = profilesOf(runner('c', 'claude'))['engineering--engineer'];
    expect(p.extraAllowedTools).toEqual(expect.arrayContaining(['Bash(mt-git record-push:*)', 'Bash(mt-git record-fetch)']));
    expect(p.instructions).toContain('record-push');
    expect(profilesOf(runner('x', 'codex'))['engineering--engineer'].instructions).toContain('record-fetch');
  });
});

describe('the Deployment of an agent pod', () => {
  it('has a shared-memory volume for the browser, a work volume to build in and a larger temporary folder', () => {
    const d = deployment(runner('c', 'claude'));
    const vols = d.spec.template.spec.volumes;
    expect(vols.find((v: any) => v.name === 'dshm')).toEqual({ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } });
    expect(bridgeOf(d).volumeMounts).toEqual(expect.arrayContaining([{ name: 'dshm', mountPath: '/dev/shm' }]));
    expect(vols.find((v: any) => v.name === 'tmp').emptyDir.sizeLimit).toBe('2Gi');
    expect(bridgeOf(d).resources.limits.memory).toBe('4Gi');
    expect(bridgeOf(d).securityContext).toMatchObject({ readOnlyRootFilesystem: true, allowPrivilegeEscalation: false });
  });

  it('has no keeper, no keeper token and no Kubernetes identity without an uploaded sign-in file, and no API label', () => {
    const d = deployment(runner('c', 'claude'));
    expect(d.spec.template.spec.containers.map((c: any) => c.name)).not.toContain('keeper');
    expect(d.spec.template.spec.serviceAccountName).toBeUndefined();
    expect(d.spec.template.spec.volumes.map((v: any) => v.name)).not.toContain('keeper-token');
    expect(d.spec.template.metadata.labels['manythreads.io/kube-api']).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('/creds');
  });

  it('keeps the keeper, its token and the API label for the older uploaded-file runner', () => {
    const d = deployment(runner('c', 'claude'), { keeper: true });
    expect(d.spec.template.spec.containers.map((c: any) => c.name)).toContain('keeper');
    expect(d.spec.template.spec.serviceAccountName).toBe(namesFor('c').keeper);
    expect(d.spec.template.metadata.labels['manythreads.io/kube-api']).toBe('true');
  });

  it('mounts the deployer kubeconfig into the run container only, read-only, and labels the pod for the API', () => {
    const r = runner('c', 'claude', { bots: [ENG, DEP] });
    const d = deployment(r, { deployMounts: DEPLOY.mounts });
    const mounted = d.spec.template.spec.containers.filter((c: any) => JSON.stringify(c.volumeMounts).includes('/etc/deployer')).map((c: any) => c.name);
    expect(mounted).toEqual(['bridge']);
    const vol = d.spec.template.spec.volumes.find((v: any) => v.secret?.secretName === 'hermes-engineering-deployer');
    expect(vol).toBeTruthy();
    const mount = bridgeOf(d).volumeMounts.find((m: any) => m.name === vol.name);
    expect(mount).toMatchObject({ readOnly: true });
    expect(mount.mountPath.startsWith('/etc/deployer/')).toBe(true);
    expect(d.spec.template.metadata.labels['manythreads.io/kube-api']).toBe('true');
    expect(d.spec.template.spec.automountServiceAccountToken).toBe(false);
  });
});

describe('the controller for an agent pod', () => {
  const pod = (k8s: FakeK8s, name: string, agent: 'claude' | 'codex'): void => {
    const base = namesFor(name, agent, 'engineering').base;
    k8s.store.set(`Pod/bots/${base}-1`, { apiVersion: 'v1', kind: 'Pod', metadata: { name: `${base}-1`, namespace: 'bots', labels: { 'manythreads.io/pod': base } }, status: { phase: 'Running' } });
  };
  const make = (runners: PodRunner[], doFetch: typeof fetch, extra: Partial<RunnerSource> = {}) => {
    const k8s = new FakeK8s();
    const reports: string[] = [];
    const source: RunnerSource = { runners: async () => runners, report: async (s) => void reports.push(s.status), ...extra };
    return { k8s, reports, r: new Reconciler(k8s, CFG, source, LOG, () => 'k'.repeat(48), () => 1_000_000, doFetch) };
  };

  it('is ready when the bridge says the agent is signed in (the sign-in was made from the Runners page), and asks with the pod\'s own key', async () => {
    const seen: { url: string; auth: string }[] = [];
    const doFetch = (async (url: string, init: RequestInit) => (seen.push({ url, auth: String((init.headers as Record<string, string>)['authorization']) }), new Response(JSON.stringify({ auth: { state: 'signed_in' } }), { status: 200 }))) as unknown as typeof fetch;
    const { k8s, reports, r } = make([runner('x', 'codex')], doFetch);
    pod(k8s, 'x', 'codex');
    const res = await r.reconcileAll();
    expect(res[0]?.state).toBe('ready');
    expect(reports.at(-1)).toBe('ready');
    expect(seen[0]?.url).toBe('http://codex-x-engineering.bots.svc:8650/v1/auth/status?agent=codex');
    expect(seen[0]?.auth).toBe(`Bearer ${'k'.repeat(48)}`);
  });

  it('waits for a sign-in while the bridge says signed out, or does not answer, and never reports ready', async () => {
    for (const doFetch of [
      (async () => new Response(JSON.stringify({ auth: { state: 'signed_out' } }), { status: 200 })) as unknown as typeof fetch,
      (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
      (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    ]) {
      const { k8s, r } = make([runner('c', 'claude')], doFetch);
      pod(k8s, 'c', 'claude');
      const res = await r.reconcileAll();
      expect(res[0]?.state).toBe('waiting_for_sign_in');
    }
  });

  it('does not ask the bridge when there is an uploaded sign-in file (the keeper holds it) or no pod is running', async () => {
    let asked = 0;
    const doFetch = (async (url: string) => (String(url).includes('/v1/auth/status') && asked++, new Response(JSON.stringify({ auth: { state: 'signed_in' } }), { status: 200 }))) as unknown as typeof fetch;
    const a = make([runner('c', 'claude')], doFetch);
    await a.r.reconcileAll(); // no pod yet
    expect(asked).toBe(0);
    const b = make([runner('d', 'claude')], doFetch);
    b.k8s.store.set(`Secret/bots/${namesFor('d').credentials}`, { apiVersion: 'v1', kind: 'Secret', metadata: { name: namesFor('d').credentials, namespace: 'bots' }, data: {} });
    pod(b.k8s, 'd', 'claude');
    expect((await b.r.reconcileAll())[0]?.state).toBe('ready');
    expect(asked).toBe(0);
  });

  it('stops the pod while the state volume of a removed sign-in is still being deleted, and runs it again after', async () => {
    const { k8s, r } = make([runner('c', 'claude')], (async () => new Response('', { status: 503 })) as typeof fetch);
    await r.reconcileAll();
    const claim = k8s.store.get(`PersistentVolumeClaim/bots/${namesFor('c').state}`)!;
    claim.metadata.deletionTimestamp = '2026-11-15T00:00:00Z';
    const going = await r.reconcileAll();
    expect(going[0]?.replicas).toBe(0);
    k8s.store.delete(`PersistentVolumeClaim/bots/${namesFor('c').state}`);
    expect((await r.reconcileAll())[0]?.replicas).toBe(1);
    expect(k8s.store.has(`PersistentVolumeClaim/bots/${namesFor('c').state}`)).toBe(true);
  });

  it('mounts the deployer kubeconfig into the pod of the team that has the deployer bot, and into no other pod', async () => {
    const asked: string[] = [];
    const deployerKubeconfig = async (team: { id: string; slug: string }) => (asked.push(team.slug), { secret: `hermes-${team.slug}-deployer`, key: 'deployer.kubeconfig' });
    const offline = (async () => new Response('', { status: 503 })) as typeof fetch;

    const one = make([runner('c', 'claude', { bots: [ENG, DEP] })], offline, { deployerKubeconfig });
    await one.r.reconcileAll();
    const d: any = one.k8s.store.get(`Deployment/bots/${namesFor('c', 'claude', 'engineering').base}`);
    expect(JSON.stringify(d)).toContain('hermes-engineering-deployer');
    expect(d.spec.template.metadata.labels['manythreads.io/kube-api']).toBe('true');
    const cfg = JSON.parse(((await one.k8s.get('ConfigMap', 'bots', namesFor('c', 'claude', 'engineering').config))!.data as any)['config.json']);
    expect(cfg.profiles['engineering--deployer'].env.KUBECONFIG).toBeTruthy();
    expect(cfg.profiles['engineering--engineer'].env.KUBECONFIG).toBeUndefined();

    // no deployer bot on the pod: the platform is not even asked
    asked.length = 0;
    const none = make([runner('n', 'claude')], offline, { deployerKubeconfig });
    await none.r.reconcileAll();
    expect(asked).toEqual([]);
    expect(JSON.stringify(none.k8s.store.get(`Deployment/bots/${namesFor('n', 'claude', 'engineering').base}`))).not.toContain('deployer');
    expect((none.k8s.store.get(`Deployment/bots/${namesFor('n', 'claude', 'engineering').base}`) as any).spec.template.metadata.labels['manythreads.io/kube-api']).toBeUndefined();

    // two teams on one runner: each team's pod gets its own team's login and no other (the second team's deployer has its own pod and its own Secret)
    asked.length = 0;
    const two = make([runner('t', 'claude', { allTeams: true, bots: [ENG, DEP, MKT] })], offline, { deployerKubeconfig });
    await two.r.reconcileAll();
    expect(asked.sort()).toEqual(['engineering', 'marketing']);
    const eng = JSON.stringify(two.k8s.store.get(`Deployment/bots/${namesFor('t', 'claude', 'engineering').base}`));
    const mkt = JSON.stringify(two.k8s.store.get(`Deployment/bots/${namesFor('t', 'claude', 'marketing').base}`));
    expect(eng).toContain('hermes-engineering-deployer');
    expect(eng).not.toContain('hermes-marketing-deployer');
    expect(mkt).toContain('hermes-marketing-deployer');
    expect(mkt).not.toContain('hermes-engineering-deployer');

    // the platform has no kubeconfig for the team (provider off or the team has no deployer): the pod runs without
    const missing = make([runner('m', 'claude', { bots: [ENG, DEP] })], offline, { deployerKubeconfig: async () => null });
    await missing.r.reconcileAll();
    expect(JSON.stringify(missing.k8s.store.get(`Deployment/bots/${namesFor('m', 'claude', 'engineering').base}`))).not.toContain('/etc/deployer');
  });
});
