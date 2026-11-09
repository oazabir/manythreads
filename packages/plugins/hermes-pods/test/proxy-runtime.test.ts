/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read rendered Kubernetes objects whose shape the assertions then pin */
import type { GatewayProfileSpec, PluginLogger } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { configFrom, runtimeClassOf } from '../src/config.ts';
import type { K8s, K8sObject } from '../src/k8s.ts';
import { Reconciler, type ProfileSource } from '../src/reconcile.ts';
import { EGRESS_LABEL, NO_PROXY, buildDeployment, namesFor, proxyEnv, proxyUrlOf, type PodConfig } from '../src/render.ts';

// P10-08: a team's own proxy (E21) and the pods' RuntimeClass (E22) in the objects the controller makes. The chart's policy per team is tested in deploy/helm/test.

const CFG: PodConfig = {
  namespace: 'manythreads-bots',
  hermesImage: 'manythreads/hermes-pod:1',
  workbenchImage: 'manythreads/workbench:2',
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
const names = namesFor(TEAM);
const envOf = (dep: any, container: string): Record<string, string> =>
  Object.fromEntries(((dep.spec.template.spec.containers.find((c: any) => c.name === container).env ?? []) as { name: string; value: string }[]).map((e) => [e.name, e.value]));

describe('proxyUrlOf', () => {
  it.each([
    ['http://proxy.corp.example:3128', 'http://proxy.corp.example:3128'],
    ['https://proxy.corp.example', 'https://proxy.corp.example'],
    ['http://203.0.113.10:8080/', 'http://203.0.113.10:8080'],
    ['HTTP://Proxy.Corp.Example:3128', 'http://proxy.corp.example:3128'],
  ])('takes %s', (raw, want) => expect(proxyUrlOf(raw)).toBe(want));

  it.each([
    'http://user:pass@proxy.corp.example:3128', // a sign-in in the address
    'http://user@proxy.corp.example',
    'http://proxy.corp.example/path',
    'http://proxy.corp.example/?q=1',
    'socks5://proxy.corp.example:1080',
    'ftp://proxy.corp.example',
    'proxy.corp.example:3128',
    'http://localhost:3128',
    'http://127.0.0.1:3128',
    'http://127.8.8.8',
    'http://169.254.169.254', // the node's metadata address
    'http://0.0.0.0',
    'http://[::1]:3128',
    '',
    `http://${'a'.repeat(400)}.example`,
  ])('refuses %s', (raw) => expect(proxyUrlOf(raw)).toBeNull());

  it('refuses nothing it was not given', () => {
    expect(proxyUrlOf(null)).toBeNull();
    expect(proxyUrlOf(undefined)).toBeNull();
  });
});

describe('buildDeployment with a proxy', () => {
  it('sends both containers through the proxy, keeps the cluster itself direct, and labels the pod so the shared internet policy leaves it out', () => {
    const dep: any = buildDeployment(CFG, TEAM, names, { replicas: 1, withDeployer: false, proxy: 'http://proxy.corp.example:3128' });
    for (const c of ['hermes', 'workbench']) {
      const env = envOf(dep, c);
      expect(env['HTTPS_PROXY'], c).toBe('http://proxy.corp.example:3128');
      expect(env['HTTP_PROXY'], c).toBe('http://proxy.corp.example:3128');
      expect(env['https_proxy'], c).toBe('http://proxy.corp.example:3128');
      expect(env['NO_PROXY'], c).toBe(NO_PROXY);
    }
    expect(NO_PROXY.split(',')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '.svc', '.cluster.local', 'manythreads-server', 'manythreads-litellm']));
    expect(dep.spec.template.metadata.labels[EGRESS_LABEL]).toBe('proxy');
    // the Deployment's selector is not touched (a changed selector would be refused by the cluster)
    expect(dep.spec.selector.matchLabels).toEqual({ 'manythreads.io/pod': names.base });
  });

  it('without a proxy: no proxy variable, no label (the pod is as it was)', () => {
    for (const proxy of [undefined, null]) {
      const dep: any = buildDeployment(CFG, TEAM, names, { replicas: 1, withDeployer: false, proxy });
      expect(Object.keys(envOf(dep, 'hermes')).filter((k) => /proxy/i.test(k))).toEqual([]);
      expect(dep.spec.template.spec.containers.find((c: any) => c.name === 'workbench').env).toBeUndefined();
      expect(dep.spec.template.metadata.labels[EGRESS_LABEL]).toBeUndefined();
    }
  });

  it('an unusable address that reaches the builder is dropped, not written into a pod', () => {
    const dep: any = buildDeployment(CFG, TEAM, names, { replicas: 1, withDeployer: false, proxy: 'http://user:pw@proxy.corp.example' });
    expect(JSON.stringify(dep)).not.toContain('pw@');
    expect(dep.spec.template.metadata.labels[EGRESS_LABEL]).toBeUndefined();
  });

  it('proxyEnv names both spellings', () => {
    expect(proxyEnv('http://p:1').map((e) => e.name)).toEqual(['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy']);
  });
});

describe('runtimeClassName', () => {
  it('goes into the pod spec when the chart names one', () => {
    const dep: any = buildDeployment({ ...CFG, runtimeClassName: 'gvisor' }, TEAM, names, { replicas: 1, withDeployer: false });
    expect(dep.spec.template.spec.runtimeClassName).toBe('gvisor');
  });
  it('is absent when none is named (the cluster default runtime), and ignored when it is not a name', () => {
    for (const rc of [undefined, '', 'Bad Name', 'x;y']) {
      const dep: any = buildDeployment({ ...CFG, runtimeClassName: rc }, TEAM, names, { replicas: 1, withDeployer: false });
      expect('runtimeClassName' in dep.spec.template.spec, String(rc)).toBe(false);
    }
  });
  it('is read from the environment the chart sets', () => {
    expect(configFrom({ MANYTHREADS_HERMES_PODS_RUNTIME_CLASS_NAME: 'gvisor' }).runtimeClassName).toBe('gvisor');
    expect(configFrom({}).runtimeClassName).toBe('');
    expect(configFrom({ MANYTHREADS_HERMES_PODS_RUNTIME_CLASS_NAME: 'a b' }).runtimeClassName).toBe('');
    expect(runtimeClassOf('runsc')).toBe('runsc');
  });
});

class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  async apply(obj: K8sObject): Promise<void> {
    this.store.set(`${obj.kind}/${obj.metadata.name}`, structuredClone(obj));
  }
  async get(kind: string, _ns: string, name: string): Promise<K8sObject | null> {
    return structuredClone(this.store.get(`${kind}/${name}`) ?? null);
  }
  async delete(): Promise<void> {}
  async list(): Promise<K8sObject[]> {
    return [];
  }
}

const profile: GatewayProfileSpec = {
  profile: 'mt-helper',
  botId: 'bot-helper',
  files: { 'SOUL.md': 'I am helper', 'config.yaml': 'model:\n  default: fast\n', '.env.template': 'API_SERVER_KEY=\n' },
  secrets: { MCP_TOKEN: 'mcp', LLM_KEY: 'llm', API_SERVER_KEY: 'key-0123456789abcdef0123' },
};

describe('the controller and the team rule', () => {
  const logs: string[] = [];
  const LOG: PluginLogger = { info: (m) => void logs.push(m), warn: (m) => void logs.push(`WARN ${m}`) };
  const sourceWith = (proxyForTeam: ProfileSource['proxyForTeam']): ProfileSource => ({ profilesForTeam: async () => [profile], ...(proxyForTeam ? { proxyForTeam } : {}) });
  const deployment = (k8s: FakeK8s): any => k8s.store.get(`Deployment/${names.base}`);

  it('a team whose rule names a proxy gets the proxy environment; when the rule goes away the next pass takes it off again', async () => {
    const k8s = new FakeK8s();
    let stored: string | null = 'http://proxy.corp.example:3128';
    const r = new Reconciler(k8s, CFG, sourceWith(async () => stored), LOG);
    await r.reconcileTeam(TEAM);
    expect(envOf(deployment(k8s), 'hermes')['HTTPS_PROXY']).toBe('http://proxy.corp.example:3128');
    expect(deployment(k8s).spec.template.metadata.labels[EGRESS_LABEL]).toBe('proxy');
    stored = null;
    await r.reconcileTeam(TEAM);
    expect(envOf(deployment(k8s), 'hermes')['HTTPS_PROXY']).toBeUndefined();
    expect(deployment(k8s).spec.template.metadata.labels[EGRESS_LABEL]).toBeUndefined();
  });

  it('an address that is not usable starts the pod WITHOUT a proxy and says so, naming no address', async () => {
    const k8s = new FakeK8s();
    const r = new Reconciler(k8s, CFG, sourceWith(async () => 'http://user:secretpw@proxy.corp.example'), LOG);
    await r.reconcileTeam(TEAM);
    expect(envOf(deployment(k8s), 'hermes')['HTTPS_PROXY']).toBeUndefined();
    const warn = logs.find((l) => l.includes('proxy address is not usable'));
    expect(warn).toBeDefined();
    expect(warn).not.toContain('secretpw');
  });

  it('a read that fails fails the pass and writes nothing (it must not move a pod in or out of the proxy on a guess)', async () => {
    const k8s = new FakeK8s();
    const r = new Reconciler(k8s, CFG, sourceWith(async () => { throw new Error('database unreachable'); }), LOG);
    await expect(r.reconcileTeam(TEAM)).rejects.toThrow('database unreachable');
    expect(deployment(k8s)).toBeUndefined();
  });

  it('a source that knows no teams rules (the test-only static mode) makes a pod with no proxy', async () => {
    const k8s = new FakeK8s();
    await new Reconciler(k8s, CFG, sourceWith(undefined), LOG).reconcileTeam(TEAM);
    expect(envOf(deployment(k8s), 'hermes')['HTTPS_PROXY']).toBeUndefined();
  });
});
