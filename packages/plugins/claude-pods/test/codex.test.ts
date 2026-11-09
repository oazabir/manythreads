/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed JSON documents whose shape the assertions then pin */
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import type { BotRunnersProvider, PluginLogger, PodRunnerInfo } from '@manythreads/sdk';
import type { K8s, K8sObject } from '@manythreads/sdk/pods';
import { describe, expect, it } from 'vitest';
import { configFrom, type ClaudePodConfig } from '../src/config.ts';
import { platformSource, providerFor } from '../src/index.ts';
import { Reconciler, type RunnerSource } from '../src/reconcile.ts';
import { buildBridgeConfig, namesFor, type PodRunner } from '../src/render.ts';

// P19-13 (pod half): a Codex runner's objects. Same plugin, same reconciler; the names, the sign-in Secret key, CODEX_HOME, the keeper's file and the profile's agent differ.

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
  snapshot(): string {
    return JSON.stringify([...this.store.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

const CFG: ClaudePodConfig = { ...configFrom({}), namespace: 'bots', image: 'manythreads/claude-pod:1', serverUrl: 'http://manythreads-server.manythreads.svc:3000', repoOriginAllow: ['https://github.com/acme/'] };
const LOG: PluginLogger = { info: () => undefined, warn: () => undefined };
const BOT = { teamId: 't-eng', teamSlug: 'engineering', botSlug: 'engineer' };

const runner = (name: string, agent: 'claude' | 'codex', over: Partial<PodRunnerInfo> = {}): PodRunner => ({
  id: `00000000-0000-4000-8000-${name.replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12)}`,
  workspaceId: 'w1',
  name,
  enabled: true,
  node: null,
  maxConcurrent: null,
  teams: [{ id: 't-eng', slug: 'engineering' }],
  allTeams: false,
  bots: [BOT],
  agent,
  ...over,
});

function setup(runners: PodRunner[]) {
  const k8s = new FakeK8s();
  const source: RunnerSource = {
    runners: async () => runners,
    reposForTeams: async () => [{ teamSlug: 'engineering', name: 'app', origin: 'https://github.com/acme/app.git', branch: 'main' }],
    publishersForTeams: async () => [{ teamSlug: 'engineering', botSlug: 'engineer' }],
  };
  return { k8s, r: new Reconciler(k8s, CFG, source, LOG, () => 'k'.repeat(48), () => 1_000_000, (async () => new Response('', { status: 503 })) as typeof fetch) };
}
const signIn = (k8s: FakeK8s, name: string, agent: 'claude' | 'codex'): void => {
  const n = namesFor(name, agent);
  k8s.store.set(`Secret/bots/${n.credentials}`, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: n.credentials, namespace: 'bots' },
    data: { [n.file]: Buffer.from('{"made":"up"}').toString('base64'), 'upload-id': Buffer.from('up-1').toString('base64') },
  });
};
const depOf = (k8s: FakeK8s, name: string, agent: 'claude' | 'codex'): any => k8s.store.get(`Deployment/bots/${namesFor(name, agent).base}`)!;

describe('names of a Codex runner', () => {
  it('are codex-<runner>…, the sign-in Secret holds auth.json, and no name is shared with a Claude runner of the same name', () => {
    const n = namesFor('team-codex', 'codex');
    expect(n).toEqual({
      agent: 'codex',
      base: 'codex-team-codex',
      state: 'codex-team-codex-state',
      work: 'codex-team-codex-work',
      key: 'codex-team-codex-key',
      credentials: 'codex-team-codex-credentials',
      file: 'auth.json',
      config: 'codex-team-codex-config',
      keeper: 'codex-team-codex-keeper',
    });
    const c = namesFor('team-codex', 'claude');
    expect(c.file).toBe('.credentials.json');
    expect(namesFor('team-codex')).toEqual(c);
    const mine = new Set(Object.entries(n).filter(([k]) => k !== 'agent' && k !== 'file').map(([, v]) => v));
    for (const [k, v] of Object.entries(c)) if (k !== 'agent' && k !== 'file') expect(mine.has(v), `${k} ${v}`).toBe(false);
  });
});

describe('the objects of a Codex runner', () => {
  it('match the stored rendering byte for byte (test/golden/codex-runner.json); a second pass changes nothing', async () => {
    const { k8s, r } = setup([runner('team-codex', 'codex', { maxConcurrent: 2 })]);
    signIn(k8s, 'team-codex', 'codex');
    await r.reconcileAll();
    const first = k8s.snapshot();
    const rendered = JSON.stringify([...k8s.store.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, o]) => o), null, 2) + '\n';
    const file = fileURLToPath(new URL('./golden/codex-runner.json', import.meta.url));
    if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(file, rendered);
    expect(rendered).toBe(readFileSync(file, 'utf8'));
    await r.reconcileAll();
    expect(k8s.snapshot()).toBe(first);
  });

  it('puts the Codex pieces where the plan says: CODEX_HOME, the in-pod switch, auth.json in the init step and the keeper, profile agent codex, no Claude variable', async () => {
    const { k8s, r } = setup([runner('team-codex', 'codex')]);
    signIn(k8s, 'team-codex', 'codex');
    await r.reconcileAll();
    const d = depOf(k8s, 'team-codex', 'codex');
    const spec = d.spec.template.spec;
    expect(d.metadata.name).toBe('codex-team-codex');
    expect(spec.serviceAccountName).toBe('codex-team-codex-keeper');
    expect(spec.containers.map((c: any) => c.name)).toEqual(['bridge', 'keeper', 'repo-sync', 'publisher']);
    const bridge = spec.containers.find((c: any) => c.name === 'bridge');
    expect(bridge.env).toEqual(
      expect.arrayContaining([
        { name: 'CODEX_HOME', value: '/state/codex' },
        { name: 'MANYTHREADS_BRIDGE_IN_POD', value: '1' },
      ]),
    );
    expect(JSON.stringify(spec)).not.toContain('CLAUDE_CONFIG_DIR');
    expect(JSON.stringify(spec)).not.toContain('.credentials.json');
    expect(JSON.stringify(spec)).not.toContain('/state/claude');
    const keeper = spec.containers.find((c: any) => c.name === 'keeper');
    expect(keeper.env).toEqual(
      expect.arrayContaining([
        { name: 'KEEPER_SECRET', value: 'codex-team-codex-credentials' },
        { name: 'KEEPER_KIND', value: 'codex' },
        { name: 'KEEPER_FILE', value: '/state/codex/auth.json' },
        { name: 'KEEPER_KEY', value: 'auth.json' },
        { name: 'KEEPER_LOCK', value: '/state/codex/auth.lock' },
      ]),
    );
    expect(keeper.volumeMounts.find((m: any) => m.name === 'state')).toEqual({ name: 'state', mountPath: '/state/codex', subPath: 'codex', readOnly: true });
    expect(spec.initContainers[0].command[2]).toContain('/creds/auth.json');
    expect(spec.initContainers[0].command[2]).toContain('/state/codex/auth.json');
    // only the keeper has the Kubernetes token; the run container mounts no push Secret
    expect(spec.containers.filter((c: any) => c.volumeMounts.some((m: any) => m.name === 'keeper-token')).map((c: any) => c.name)).toEqual(['keeper']);
    expect(bridge.volumeMounts.some((m: any) => m.name.startsWith('push-'))).toBe(false);
    expect(d.spec.replicas).toBe(1);

    const cm = JSON.parse(((await k8s.get('ConfigMap', 'bots', 'codex-team-codex-config'))!.data as any)['config.json']);
    const p = cm.profiles['engineering--engineer'];
    expect(p).toMatchObject({ agent: 'codex', workdir: '/work/engineering/engineer', env: { CODEX_HOME: '/state/codex', HOME: '/state/home' } });
    expect(p.extraAllowedTools).toBeUndefined();
    expect(p.instructions).toContain('Codex runner');
    expect(p.instructions).toContain('mt-publish');
  });

  it('a Codex runner without a sign-in file runs no pod and says so', async () => {
    const { r } = setup([runner('team-codex', 'codex')]);
    const res = await r.reconcileAll();
    expect(res[0]).toMatchObject({ replicas: 0, state: 'waiting_for_sign_in', pod: 'codex-team-codex' });
  });

  it('the Claude pod of a Claude runner is unchanged: still claude-…, .credentials.json, CLAUDE_CONFIG_DIR, no in-pod switch', async () => {
    const { k8s, r } = setup([runner('plain', 'claude')]);
    signIn(k8s, 'plain', 'claude');
    await r.reconcileAll();
    const spec = depOf(k8s, 'plain', 'claude').spec.template.spec;
    const bridge = spec.containers.find((c: any) => c.name === 'bridge');
    expect(bridge.env.map((e: any) => e.name)).toEqual(['AGENT_BRIDGE_API_KEY', 'HOME', 'CLAUDE_CONFIG_DIR']);
    const keeper = spec.containers.find((c: any) => c.name === 'keeper');
    expect(keeper.env.map((e: any) => e.name)).toEqual(['KEEPER_NAMESPACE', 'KEEPER_SECRET']);
    expect(JSON.parse(buildBridgeConfig(CFG, runner('plain', 'claude'))).profiles['engineering--engineer'].agent).toBe('claude-code');
  });
});

describe('a Claude and a Codex runner together', () => {
  it('make disjoint sets of objects, and each keeper Role can reach its own sign-in Secret only', async () => {
    const { k8s, r } = setup([runner('alpha', 'claude'), runner('beta', 'codex')]);
    signIn(k8s, 'alpha', 'claude');
    signIn(k8s, 'beta', 'codex');
    await r.reconcileAll();
    const ofRunner = (id: string): Set<string> => new Set([...k8s.store.entries()].filter(([, o]) => o.metadata.labels?.['manythreads.io/runner-id'] === id).map(([k]) => k));
    const a = ofRunner(runner('alpha', 'claude').id);
    const b = ofRunner(runner('beta', 'codex').id);
    expect(a.size).toBeGreaterThan(8);
    expect(b.size).toBe(a.size);
    expect([...a].filter((k) => b.has(k))).toEqual([]);
    // the sign-in Secrets are made by the upload route, not the controller: they are disjoint too
    expect(namesFor('alpha', 'claude').credentials).not.toBe(namesFor('beta', 'codex').credentials);

    for (const [name, agent, other] of [['alpha', 'claude', 'beta'], ['beta', 'codex', 'alpha']] as const) {
      const n = namesFor(name, agent);
      const otherNames = namesFor(other, agent === 'claude' ? 'codex' : 'claude');
      const role = k8s.store.get(`Role/bots/${n.keeper}`) as any;
      // every rule names exactly the one sign-in Secret and can only read and patch it: no list, no create, no rule without resourceNames
      expect(role.rules).toEqual([{ apiGroups: [''], resources: ['secrets'], resourceNames: [n.credentials], verbs: ['get', 'patch'] }]);
      const reachable = new Set(role.rules.flatMap((rule: any) => (rule.resources.includes('secrets') ? rule.resourceNames : [])));
      for (const secret of [otherNames.credentials, otherNames.key, n.key, 'hermes-engineering-push']) expect(reachable.has(secret), secret).toBe(false);
      const binding = k8s.store.get(`RoleBinding/bots/${n.keeper}`) as any;
      expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: n.keeper, namespace: 'bots' }]);
      expect(binding.roleRef.name).toBe(n.keeper);
    }
  });

  it('a runner that vanishes from the list is scaled to zero, and a pass sees both kinds so the other kind is left running', async () => {
    const live: PodRunner[] = [runner('alpha', 'claude'), runner('beta', 'codex')];
    const { k8s, r } = setup(live);
    signIn(k8s, 'alpha', 'claude');
    signIn(k8s, 'beta', 'codex');
    await r.reconcileAll();
    live.splice(1, 1);
    await r.reconcileAll();
    expect(depOf(k8s, 'alpha', 'claude').spec.replicas).toBe(1);
    expect(depOf(k8s, 'beta', 'codex').spec.replicas).toBe(0);
    expect(k8s.store.has('PersistentVolumeClaim/bots/codex-beta-work')).toBe(true);
  });
});

describe('the provider for the Runners page', () => {
  const holder = (k8s: FakeK8s) => providerFor(() => ({}) as Reconciler, () => k8s, CFG);

  it('stores a Codex sign-in file byte for byte under auth.json in codex-<runner>-credentials, and removes that Secret only', async () => {
    const k8s = new FakeK8s();
    const p = holder(k8s);
    const bytes = new TextEncoder().encode('{"canary":"CODEX-CANARY-1"}\n');
    await p.putCredentials({ runnerName: 'beta', runnerId: 'r-1', bytes, uploadId: 'up-9', agent: 'codex' });
    await p.putCredentials({ runnerName: 'beta', runnerId: 'r-1', bytes, uploadId: 'up-9' });
    const codex = k8s.store.get('Secret/bots/codex-beta-credentials') as any;
    expect(Object.keys(codex.data).sort()).toEqual(['auth.json', 'upload-id']);
    expect(Buffer.from(codex.data['auth.json'], 'base64').toString()).toBe('{"canary":"CODEX-CANARY-1"}\n');
    expect(Object.keys((k8s.store.get('Secret/bots/claude-beta-credentials') as any).data).sort()).toEqual(['.credentials.json', 'upload-id']);
    await p.removeCredentials({ runnerName: 'beta', agent: 'codex' });
    expect(k8s.store.has('Secret/bots/codex-beta-credentials')).toBe(false);
    expect(k8s.store.has('Secret/bots/claude-beta-credentials')).toBe(true);
  });

  it('finds a Codex pod\'s bridge by its own key Secret', async () => {
    const k8s = new FakeK8s();
    k8s.store.set('Secret/bots/codex-beta-key', { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'codex-beta-key', namespace: 'bots' }, data: { 'api-key': Buffer.from('the-key').toString('base64') } });
    const p = holder(k8s);
    expect(await p.bridge({ runnerName: 'beta', agent: 'codex' })).toEqual({ address: 'http://codex-beta.bots.svc:8650', key: 'the-key' });
    expect(await p.bridge({ runnerName: 'beta' })).toBeNull();
  });
});

describe('the runner list', () => {
  it('asks the catalog for both kinds and marks each runner with its tool', async () => {
    const asked: string[] = [];
    const info = (name: string): PodRunnerInfo => ({ ...runner(name, 'claude') });
    const provider = {
      id: 'bot.runners',
      podRunners: async ({ kind }: { kind: string }) => (asked.push(kind), kind === 'claude_cli' ? [info('c1')] : [info('x1')]),
    } as unknown as BotRunnersProvider;
    const source = platformSource({ providers: { get: () => provider } } as any);
    const list = await source.runners();
    expect(asked.sort()).toEqual(['claude_cli', 'codex_cli']);
    expect(list.map((r) => [r.name, r.agent])).toEqual([['c1', 'claude'], ['x1', 'codex']]);
  });

  it('fails the whole pass when one kind cannot be read, so the other kind\'s pods are not taken for pods of runners that are gone', async () => {
    let codexReadable = true;
    const provider = {
      id: 'bot.runners',
      podRunners: async ({ kind }: { kind: string }) => {
        if (kind === 'codex_cli') {
          if (!codexReadable) throw new Error('database busy');
          return [runner('x1', 'codex')];
        }
        return [runner('c1', 'claude')];
      },
    } as unknown as BotRunnersProvider;
    const k8s = new FakeK8s();
    const live = new Reconciler(k8s, CFG, { runners: platformSource({ providers: { get: () => provider } } as any).runners }, LOG);
    signIn(k8s, 'c1', 'claude');
    signIn(k8s, 'x1', 'codex');
    await live.reconcileAll();
    expect(depOf(k8s, 'c1', 'claude').spec.replicas).toBe(1);
    expect(depOf(k8s, 'x1', 'codex').spec.replicas).toBe(1);
    codexReadable = false;
    const before = k8s.snapshot();
    await expect(live.reconcileAll()).rejects.toThrow('database busy');
    expect(k8s.snapshot()).toBe(before);
  });
});
