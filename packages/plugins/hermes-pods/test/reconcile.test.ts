/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed JSON documents whose shape the assertions then pin */
import { createServer, type Server } from 'node:http';
import type { GatewayProfileSpec, PluginLogger } from '@manythreads/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import hermesPods, { staticSource, startController } from '../src/index.ts';
import { HttpK8s, resourcePath, type K8s, type K8sObject } from '../src/k8s.ts';
import { Reconciler, type ProfileSource } from '../src/reconcile.ts';
import { configFrom } from '../src/config.ts';
import { appUrlFor, assignUsers, buildDeployerKubeconfig, namesFor, parseRepos, unixUserFor, type PodConfig } from '../src/render.ts';

// The controller against a fake Kubernetes API (an in-memory store with server-side-apply semantics: same object in, same object out) and
// a stand-in for the platform's `hermes.profiles` provider.

class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  applied: string[] = [];
  private key(kind: string, ns: string, name: string): string {
    return `${kind}/${ns}/${name}`;
  }
  async apply(obj: K8sObject): Promise<void> {
    this.store.set(this.key(obj.kind, obj.metadata.namespace!, obj.metadata.name), structuredClone(obj));
    this.applied.push(`${obj.kind}/${obj.metadata.name}`);
  }
  async get(kind: string, ns: string, name: string): Promise<K8sObject | null> {
    const o = this.store.get(this.key(kind, ns, name));
    if (!o) return null;
    // the API answers Secrets with base64 `data`, never `stringData`
    if (kind === 'Secret' && o['stringData']) {
      const data = Object.fromEntries(Object.entries(o['stringData'] as Record<string, string>).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
      return { ...o, data };
    }
    return structuredClone(o);
  }
  async list(kind: string, ns: string, selector: string): Promise<K8sObject[]> {
    const wanted = selector.split(',').map((s) => s.split('='));
    return [...this.store.values()].filter(
      (o) => o.kind === kind && o.metadata.namespace === ns && wanted.every(([k, v]) => o.metadata.labels?.[k!] === v),
    );
  }
}

const CFG: PodConfig = {
  namespace: 'manythreads',
  hermesImage: 'manythreads/hermes-pod:1',
  workbenchImage: 'manythreads/workbench:1',
  workspaceSize: '10Gi',
  homeSize: '2Gi',
  storageClass: 'local-path',
  repos: [{ name: 'demo' }, { name: 'ext', origin: 'https://evil.example/x.git' }],
  repoOriginAllow: [],
  deployerBot: 'deployer',
  appsPrefix: 'apps-',
  appsRouting: 'path',
  appsHost: 'example.test',
  resources: { hermes: { limits: { memory: '3Gi' } }, workbench: { limits: { memory: '4Gi' } } },
};
const TEAM = { id: '11111111-1111-4111-8111-111111111111', slug: 'engineering' };
const logs: string[] = [];
const LOG: PluginLogger = { info: (m) => void logs.push(m), warn: (m) => void logs.push(`WARN ${m}`) };

const spec = (slug: string): GatewayProfileSpec => ({
  profile: `mt-${slug}`,
  botId: `bot-${slug}`,
  files: { 'SOUL.md': `I am ${slug}`, 'config.yaml': 'model:\n  default: fast\n', '.env.template': 'API_SERVER_KEY=\n' },
  secrets: { MCP_TOKEN: `mcp-${slug}`, LLM_KEY: `llm-${slug}`, API_SERVER_KEY: `key-${slug}-0123456789abcdef` },
});

function source(profiles: GatewayProfileSpec[]): ProfileSource & { announced: { teamId: string; baseUrl: string }[] } {
  const announced: { teamId: string; baseUrl: string }[] = [];
  return { announced, profilesForTeam: async () => profiles, setManagedGateway: async (teamId, input) => void announced.push({ teamId, baseUrl: input.baseUrl }) };
}

function seedDeployerToken(k8s: FakeK8s): void {
  k8s.store.set('Secret/apps-engineering/deployer-token', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'deployer-token', namespace: 'apps-engineering' },
    stringData: { token: 'TOKEN-DEPLOYER', 'ca.crt': '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n' },
  });
}

describe('reconcileTeam', () => {
  it('creates the pod, its volumes, Service, Secrets and ConfigMap, and registers the gateway', async () => {
    const k8s = new FakeK8s();
    const src = source([spec('dev'), spec('deployer')]);
    seedDeployerToken(k8s);
    const result = await new Reconciler(k8s, CFG, src, LOG, () => 'KEY').reconcileTeam(TEAM);

    expect(result).toMatchObject({ pod: 'hermes-engineering', profiles: 2, deployer: true, gatewayUrl: 'http://hermes-engineering.manythreads.svc:8642' });
    for (const k of [
      'Deployment/manythreads/hermes-engineering',
      'Service/manythreads/hermes-engineering',
      'PersistentVolumeClaim/manythreads/hermes-engineering-workspace',
      'PersistentVolumeClaim/manythreads/hermes-engineering-home',
      'Secret/manythreads/hermes-engineering-profiles',
      'Secret/manythreads/hermes-engineering-key',
      'Secret/manythreads/hermes-engineering-deployer',
      'ConfigMap/manythreads/hermes-engineering-bots',
    ])
      expect(k8s.store.has(k), k).toBe(true);
    expect(src.announced).toEqual([{ teamId: TEAM.id, baseUrl: 'http://hermes-engineering.manythreads.svc:8642' }]);

    const dep = k8s.store.get('Deployment/manythreads/hermes-engineering')!;
    const pod = (dep['spec'] as any).template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.containers.map((c: any) => c.name)).toEqual(['hermes', 'workbench']);
    expect(pod.containers[0].securityContext).toMatchObject({ runAsNonRoot: true, allowPrivilegeEscalation: false });
    expect(pod.volumes.find((v: any) => v.name === 'shm').emptyDir).toEqual({ medium: 'Memory', sizeLimit: '1Gi' });
    // the Hermes container never sees the workspace, the workbench never sees the profile Secret
    const mounts = (n: string): string[] => pod.containers.find((c: any) => c.name === n).volumeMounts.map((m: any) => m.name);
    expect(mounts('hermes')).not.toContain('workspace');
    expect(mounts('workbench')).not.toContain('profiles-in');
    expect(mounts('workbench')).toContain('deployer');
    expect(mounts('hermes')).not.toContain('deployer');
  });

  it('writes the profiles with their secrets and one Unix user per bot; drops .env.template', async () => {
    const k8s = new FakeK8s();
    await new Reconciler(k8s, CFG, source([spec('dev'), spec('qa')]), LOG, () => 'KEY').reconcileTeam(TEAM);
    const profiles = JSON.parse((k8s.store.get('Secret/manythreads/hermes-engineering-profiles')!['stringData'] as any)['profiles.json']);
    expect(profiles.profiles.map((p: any) => [p.profile, p.user, p.cwd])).toEqual([
      ['mt-dev', 'bot-dev', '/workspace/bots/bot-dev'],
      ['mt-qa', 'bot-qa', '/workspace/bots/bot-qa'],
    ]);
    expect(profiles.profiles[0].secrets.API_SERVER_KEY).toBe('key-dev-0123456789abcdef');
    expect(Object.keys(profiles.profiles[0].files).sort()).toEqual(['SOUL.md', 'config.yaml']);
    const bots = JSON.parse((k8s.store.get('ConfigMap/manythreads/hermes-engineering-bots')!['data'] as any)['bots.json']);
    expect(bots.bots).toEqual([
      { user: 'bot-dev', uid: 20000, deployer: false },
      { user: 'bot-qa', uid: 20001, deployer: false },
    ]);
    expect(bots.repos).toEqual([{ name: 'demo' }]); // an origin outside the allowlist is dropped
  });

  it('keeps uids and the gateway key across passes, and is a no-op in content the second time', async () => {
    const k8s = new FakeK8s();
    let n = 0;
    const r = new Reconciler(k8s, CFG, source([spec('dev'), spec('qa')]), LOG, () => `KEY${++n}`);
    await r.reconcileTeam(TEAM);
    const before = JSON.stringify([...k8s.store.entries()]);
    await r.reconcileTeam(TEAM);
    expect(JSON.stringify([...k8s.store.entries()])).toBe(before);
    expect(n).toBe(1);
    // a new bot sorting before the others takes a fresh uid; the old ones keep theirs
    const r2 = new Reconciler(k8s, CFG, source([spec('aa'), spec('dev'), spec('qa')]), LOG);
    await r2.reconcileTeam(TEAM);
    const bots = JSON.parse((k8s.store.get('ConfigMap/manythreads/hermes-engineering-bots')!['data'] as any)['bots.json']).bots;
    expect(Object.fromEntries(bots.map((b: any) => [b.user, b.uid]))).toEqual({ 'bot-aa': 20002, 'bot-dev': 20000, 'bot-qa': 20001 });
  });

  it('gives the deployer credential only to the deployer bot, and only once the token exists', async () => {
    const k8s = new FakeK8s();
    const r = new Reconciler(k8s, CFG, source([spec('dev'), spec('deployer')]), LOG, () => 'KEY');
    expect((await r.reconcileTeam(TEAM)).deployer).toBe(false);
    expect(k8s.store.has('Secret/manythreads/hermes-engineering-deployer')).toBe(false);
    expect(logs.some((l) => l.includes('deployer token'))).toBe(true);
    seedDeployerToken(k8s);
    expect((await r.reconcileTeam(TEAM)).deployer).toBe(true);
    const kubeconfig = (k8s.store.get('Secret/manythreads/hermes-engineering-deployer')!['stringData'] as any)['deployer.kubeconfig'] as string;
    expect(kubeconfig).toContain('"TOKEN-DEPLOYER"');
    expect(kubeconfig).toContain('namespace: "apps-engineering"');
    const bots = JSON.parse((k8s.store.get('ConfigMap/manythreads/hermes-engineering-bots')!['data'] as any)['bots.json']).bots;
    expect(bots.filter((b: any) => b.deployer).map((b: any) => b.user)).toEqual(['bot-deployer']);
    // the credential is in no other Secret or ConfigMap
    for (const [k, o] of k8s.store) if (!k.includes('deployer')) expect(JSON.stringify(o)).not.toContain('TOKEN-DEPLOYER');
  });

  it('reads each team\'s deployer token from that team\'s own apps namespace', async () => {
    const k8s = new FakeK8s();
    seedDeployerToken(k8s); // only apps-engineering has a token
    const other = { id: '22222222-2222-4222-8222-222222222222', slug: 'marketing' };
    const res = await new Reconciler(k8s, CFG, source([spec('deployer')]), LOG, () => 'K').reconcileTeam(other);
    expect(res.deployer).toBe(false);
    expect(k8s.store.has('Secret/manythreads/hermes-marketing-deployer')).toBe(false);
  });

  it('never puts a secret value in a ConfigMap, the Deployment or a log line', async () => {
    const k8s = new FakeK8s();
    logs.length = 0;
    await new Reconciler(k8s, CFG, source([spec('dev')]), LOG, () => 'GATEWAYKEY').reconcileTeam(TEAM);
    for (const k of ['ConfigMap/manythreads/hermes-engineering-bots', 'Deployment/manythreads/hermes-engineering', 'Service/manythreads/hermes-engineering']) {
      const text = JSON.stringify(k8s.store.get(k));
      for (const secret of ['mcp-dev', 'llm-dev', 'key-dev-0123456789abcdef', 'GATEWAYKEY']) expect(text, k).not.toContain(secret);
    }
    expect(logs.join('\n')).not.toContain('mcp-dev');
  });

  it('does not take over another team\'s pod name', async () => {
    const k8s = new FakeK8s();
    k8s.store.set('Deployment/manythreads/hermes-engineering', {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'hermes-engineering', namespace: 'manythreads', labels: { 'manythreads.io/team-id': 'someone-else' } },
    });
    const res = await new Reconciler(k8s, CFG, source([spec('dev')]), LOG, () => 'K').reconcileTeam(TEAM);
    expect(res.pod).toBe('hermes-engineering-11111111');
    expect((k8s.store.get('Deployment/manythreads/hermes-engineering')!.metadata.labels as any)['manythreads.io/team-id']).toBe('someone-else');
  });
});

describe('reconcileAll', () => {
  it('scales a pod down when its team has no managed bots any more, and keeps going when one team fails', async () => {
    const k8s = new FakeK8s();
    const r = new Reconciler(k8s, CFG, source([spec('dev')]), LOG, () => 'K');
    await r.reconcileTeam(TEAM);
    expect((k8s.store.get('Deployment/manythreads/hermes-engineering')!['spec'] as any).replicas).toBe(1);
    const out = await r.reconcileAll([]);
    expect(out[0]?.profiles).toBe(0);
    expect((k8s.store.get('Deployment/manythreads/hermes-engineering')!['spec'] as any).replicas).toBe(0);
    // volumes stay
    expect(k8s.store.has('PersistentVolumeClaim/manythreads/hermes-engineering-workspace')).toBe(true);

    const failing: ProfileSource = { profilesForTeam: async (id) => { if (id === 'bad') throw new Error('boom'); return [spec('x')]; } };
    const r2 = new Reconciler(new FakeK8s(), CFG, failing, LOG, () => 'K');
    const res = await r2.reconcileAll([{ id: 'bad', slug: 'bad' }, { id: 'good', slug: 'good' }]);
    expect(res.map((x) => x.team)).toEqual(['good']);
  });
});

describe('helpers', () => {
  it('derives names, users, uids and repos', () => {
    expect(namesFor({ id: 'x', slug: 'Eng.Team' }).base).toBe('hermes-eng-team');
    expect(unixUserFor('Deployer')).toBe('bot-deployer');
    expect(unixUserFor('a'.repeat(60)).length).toBeLessThanOrEqual(31);
    expect(unixUserFor('a'.repeat(60))).not.toBe(unixUserFor('a'.repeat(61)));
    expect(assignUsers([spec('b'), spec('a')], { 'bot-b': 20007 }, '').map((u) => [u.user, u.uid])).toEqual([['bot-a', 20000], ['bot-b', 20007]]);
    expect(parseRepos('one, two=https://example.test/x.git,../bad,Bad')).toEqual([{ name: 'one' }, { name: 'two', origin: 'https://example.test/x.git' }]);
    expect(buildDeployerKubeconfig({ token: 't', caPem: 'ca', appsNamespace: 'apps' })).toContain('current-context: deployer');
  });

  it('routes apps by path by default and by host when asked', () => {
    expect(configFrom({}).appsRouting).toBe('path');
    expect(configFrom({ MANYTHREADS_HERMES_PODS_APPS_ROUTING: 'weird' }).appsRouting).toBe('path');
    expect(configFrom({ MANYTHREADS_HERMES_PODS_APPS_ROUTING: 'host' }).appsRouting).toBe('host');
    expect(appUrlFor(CFG, TEAM, 'money')).toBe('https://example.test/apps/engineering/money/');
    expect(appUrlFor({ ...CFG, appsRouting: 'host' }, TEAM, 'money')).toBe('https://money--engineering.example.test/');
    const path = buildDeployerKubeconfig({ token: 't', caPem: 'ca', appsNamespace: 'apps-engineering', appsRouting: 'path', appUrlPattern: 'https://example.test/apps/engineering/<app>/' });
    expect(path).toContain('router.middlewares: apps-engineering-apps-path@kubernetescrd');
    expect(path).toContain('current-context: deployer');
    const host = buildDeployerKubeconfig({ token: 't', caPem: 'ca', appsNamespace: 'apps-engineering', appsRouting: 'host', appUrlPattern: 'https://<app>--engineering.example.test/' });
    expect(host).not.toContain('apps-path');
    expect(buildDeployerKubeconfig({ token: 't', caPem: 'ca', appsNamespace: 'a' }).startsWith('apiVersion: v1')).toBe(true);
  });

  it('reads the static test profiles', async () => {
    const { teams, source: src } = staticSource(JSON.stringify({ engineering: [spec('dev')] }));
    expect(teams).toEqual([{ id: 'static-engineering', slug: 'engineering' }]);
    expect((await src.profilesForTeam('static-engineering')).map((p) => p.profile)).toEqual(['mt-dev']);
  });

  it('refuses static profiles in production', () => {
    const warns: string[] = [];
    const spy = console.warn;
    console.warn = (m: string) => void warns.push(m);
    try {
      startController({} as never, { MANYTHREADS_HERMES_PODS: '1', MANYTHREADS_HERMES_PODS_STATIC: '{}', NODE_ENV: 'production' });
    } finally {
      console.warn = spy;
    }
    expect(warns.join('\n')).toContain('refused in production');
  });

  it('declares a valid manifest', () => {
    expect(hermesPods.manifest.name).toBe('hermes-pods');
  });
});

describe('HttpK8s', () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  it('applies with server-side apply, sends the bearer token, and maps 404 to null', async () => {
    const seen: { method?: string | undefined; url?: string | undefined; auth?: string | undefined; type?: string | undefined; body: string }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks).toString() });
        if (req.method === 'GET' && req.url?.includes('missing')) { res.statusCode = 404; res.end('{"message":"not found"}'); return; }
        if (req.url?.startsWith('/api/v1/namespaces/ns/secrets/bad')) { res.statusCode = 403; res.end('{"message":"forbidden: nope"}'); return; }
        res.setHeader('content-type', 'application/json');
        res.end(req.method === 'GET' && !req.url?.includes('labelSelector') ? '{"kind":"Secret","metadata":{"name":"x"}}' : '{"items":[{"kind":"Deployment","metadata":{"name":"d"}}]}');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const k = new HttpK8s({ baseUrl: `http://127.0.0.1:${port}`, token: 'T0K' });

    await k.apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cm', namespace: 'ns' }, data: { a: 'b' } });
    expect(seen[0]).toMatchObject({ method: 'PATCH', auth: 'Bearer T0K', type: 'application/apply-patch+yaml' });
    expect(seen[0]!.url).toBe('/api/v1/namespaces/ns/configmaps/cm?fieldManager=manythreads-hermes-pods&force=true');
    expect(JSON.parse(seen[0]!.body).data).toEqual({ a: 'b' });
    expect(await k.get('Secret', 'ns', 'missing')).toBeNull();
    expect((await k.get('Secret', 'ns', 'x'))?.metadata.name).toBe('x');
    expect((await k.list('Deployment', 'ns', 'a=b')).length).toBe(1);
    await expect(k.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'bad', namespace: 'ns' } })).rejects.toThrow(/403 forbidden: nope/);
    expect(resourcePath('Deployment', 'ns', 'd')).toBe('/apis/apps/v1/namespaces/ns/deployments/d');
    expect(() => resourcePath('Node', 'ns')).toThrow(/unsupported/);
  });
});
