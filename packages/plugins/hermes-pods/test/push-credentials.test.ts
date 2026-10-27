import { describe, expect, it } from 'vitest';
import { HttpK8s, type K8s, type K8sObject } from '../src/k8s.ts';
import { PushCredentials } from '../src/push-credentials.ts';
import { buildDeployment, namesFor, type PodConfig } from '../src/render.ts';
import { startFakeK8s } from '../../../test-utils/src/fake-k8s.ts';

// The projects' GitHub tokens in the team pod's Secret: one key per project, written one change at a time, read back for the server's own calls to
// GitHub, deleted with the last key. Against an in-memory store first, then over HTTP against the Kubernetes double.

const TEAM = { id: '11111111-1111-4111-8111-111111111111', slug: 'engineering' };
const NS = 'manythreads';
const SECRET = 'Secret/manythreads/hermes-engineering-push';

class Store implements K8s {
  readonly store = new Map<string, K8sObject>();
  calls: string[] = [];
  private key = (k: string, ns: string, n: string) => `${k}/${ns}/${n}`;
  async apply(o: K8sObject): Promise<void> {
    this.calls.push(`apply ${o.metadata.name}`);
    this.store.set(this.key(o.kind, o.metadata.namespace!, o.metadata.name), structuredClone(o));
  }
  async get(kind: string, ns: string, name: string): Promise<K8sObject | null> {
    return structuredClone(this.store.get(this.key(kind, ns, name)) ?? null);
  }
  async list(): Promise<K8sObject[]> {
    return [];
  }
  async delete(kind: string, ns: string, name: string): Promise<void> {
    this.calls.push(`delete ${name}`);
    this.store.delete(this.key(kind, ns, name));
  }
}

const dataOf = (k8s: Store): Record<string, string> => ((k8s.store.get(SECRET) as unknown as { data: Record<string, string> }).data);
const ORIGIN = 'https://github.com/acme/widgets';
/** What the Secret holds for a project: the token and the address it was issued for, as one JSON document. */
const parsed = (v: string) => JSON.parse(Buffer.from(v, 'base64').toString('utf8')) as { token: string; origin: string; branch: string; setAt: string };

describe('PushCredentials', () => {
  it('keeps one key per project in one Secret, and a second project does not disturb the first', async () => {
    const k8s = new Store();
    const creds = new PushCredentials(() => k8s, { namespace: NS });
    await creds.put(TEAM, 'widgets', 'token-one-0123456789', ORIGIN, 'main');
    await creds.put(TEAM, 'gadgets', 'token-two-0123456789', ORIGIN, 'main');
    expect(Object.keys(dataOf(k8s))).toEqual(['widgets', 'gadgets']);
    expect(parsed(dataOf(k8s)['widgets']!)).toMatchObject({ token: 'token-one-0123456789', origin: ORIGIN, branch: 'main' });
    expect(await creds.read(TEAM, 'widgets')).toEqual({ token: 'token-one-0123456789', origin: ORIGIN, branch: 'main' });
    expect(await creds.read(TEAM, 'gadgets')).toEqual({ token: 'token-two-0123456789', origin: ORIGIN, branch: 'main' });
    expect(await creds.read(TEAM, 'nothing')).toBeNull();
    // set again: replaced, still one key
    await creds.put(TEAM, 'widgets', 'token-new-0123456789', ORIGIN, 'main');
    expect(await creds.read(TEAM, 'widgets')).toMatchObject({ token: 'token-new-0123456789' });
  });

  it('writes the Secret as `data` (so applying it again can drop a key), labelled as the team’s, and never as `stringData`', async () => {
    const k8s = new Store();
    await new PushCredentials(() => k8s, { namespace: NS }).put(TEAM, 'widgets', 'token-one-0123456789', ORIGIN, 'main');
    const s = k8s.store.get(SECRET)!;
    expect(s['stringData']).toBeUndefined();
    expect(s.metadata.labels?.['manythreads.io/team-id']).toBe(TEAM.id);
  });

  it('removes one key, and deletes the Secret with the last one; removing what is not there is not an error', async () => {
    const k8s = new Store();
    const creds = new PushCredentials(() => k8s, { namespace: NS });
    await creds.remove(TEAM, 'widgets');
    expect(k8s.calls).toEqual([]);
    await creds.put(TEAM, 'widgets', 'token-one-0123456789', ORIGIN, 'main');
    await creds.put(TEAM, 'gadgets', 'token-two-0123456789', ORIGIN, 'main');
    await creds.remove(TEAM, 'widgets');
    expect(Object.keys(dataOf(k8s))).toEqual(['gadgets']);
    await creds.remove(TEAM, 'gadgets');
    expect(k8s.store.has(SECRET)).toBe(false);
    await creds.remove(TEAM, 'gadgets');
  });

  it('serialises concurrent changes of one team’s Secret: none is lost', async () => {
    const k8s = new Store();
    const creds = new PushCredentials(() => k8s, { namespace: NS });
    await Promise.all(['a1', 'b2', 'c3', 'd4', 'e5'].map((p) => creds.put(TEAM, p, `token-for-${p}-0123456789`, ORIGIN, 'main')));
    expect(Object.keys(dataOf(k8s)).sort()).toEqual(['a1', 'b2', 'c3', 'd4', 'e5']);
  });

  it('refuses a name that is not a project name and a token with blanks, before touching the cluster', async () => {
    const k8s = new Store();
    const creds = new PushCredentials(() => k8s, { namespace: NS });
    await expect(creds.put(TEAM, '../x', 'token-one-0123456789', ORIGIN, 'main')).rejects.toThrow('bad project name');
    await expect(creds.put(TEAM, 'widgets', 'two words', ORIGIN, 'main')).rejects.toThrow('bad token');
    await expect(creds.put(TEAM, 'widgets', '', ORIGIN, 'main')).rejects.toThrow('bad token');
    await expect(creds.put(TEAM, 'widgets', 'token-one-0123456789', 'http://github.com/a/b', 'main')).rejects.toThrow('bad origin');
    expect(k8s.calls).toEqual([]);
  });

  it('puts the Secret under the pod name that is in use when another team already holds the plain one', async () => {
    const k8s = new Store();
    k8s.store.set('Deployment/manythreads/hermes-engineering', { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'hermes-engineering', namespace: NS, labels: { 'manythreads.io/team-id': 'other-team' } } });
    await new PushCredentials(() => k8s, { namespace: NS }).put(TEAM, 'widgets', 'token-one-0123456789', ORIGIN, 'main');
    expect([...k8s.store.keys()].filter((k) => k.startsWith('Secret/'))).toEqual([`Secret/manythreads/${namesFor(TEAM, true).push}`]);
  });

  it('prunes a token whose project row never got the flag, but not a young one (its row may not be committed yet) nor one that is kept', async () => {
    const k8s = new Store();
    const creds = new PushCredentials(() => k8s, { namespace: NS });
    await creds.put(TEAM, 'widgets', 'token-one-0123456789', ORIGIN, 'main');
    await creds.put(TEAM, 'gadgets', 'token-two-0123456789', ORIGIN, 'main');
    expect(await creds.prune(TEAM, new Set(['widgets']))).toEqual([]); // both are young
    const later = Date.now() + 10 * 60_000;
    expect(await creds.prune(TEAM, new Set(['widgets']), 120_000, later)).toEqual(['gadgets']);
    expect(Object.keys(dataOf(k8s))).toEqual(['widgets']);
    expect(await creds.prune(TEAM, new Set(), 120_000, later)).toEqual(['widgets']);
    expect(k8s.store.has(SECRET)).toBe(false);
  });

  it('reports a cluster failure without the token in the message', async () => {
    const fake = await startFakeK8s();
    try {
      const creds = new PushCredentials(() => new HttpK8s({ baseUrl: fake.url, token: 't' }), { namespace: NS });
      await creds.put(TEAM, 'widgets', 'token-one-0123456789', ORIGIN, 'main');
      expect(Object.keys(fake.secrets.get(`${NS}/hermes-engineering-push`)!.data!)).toEqual(['widgets']);
      expect(await creds.read(TEAM, 'widgets')).toEqual({ token: 'token-one-0123456789', origin: ORIGIN, branch: 'main' });
      fake.failNext(5);
      const err = await creds.put(TEAM, 'gadgets', 'token-two-0123456789', ORIGIN, 'main').catch((e: unknown) => e as Error);
      expect(String((err as Error).message)).not.toContain('token-two');
      fake.failNext(0);
      await creds.remove(TEAM, 'widgets');
      expect(fake.secrets.size).toBe(0);
      expect(fake.calls).toContain(`DELETE /api/v1/namespaces/${NS}/secrets/hermes-engineering-push`);
    } finally {
      await fake.stop();
    }
  });
});

describe('the pod mounts the tokens root-only and optionally', () => {
  const CFG = { namespace: NS, hermesImage: 'h', workbenchImage: 'w', workspaceSize: '1Gi', homeSize: '1Gi', storageClass: 's', repos: [], repoOriginAllow: [], deployerBot: 'deployer', appsPrefix: 'apps-', appsRouting: 'path', appsHost: 'x', resources: { hermes: {}, workbench: {} } } as unknown as PodConfig;
  it('has a Secret volume that may be missing (a team with no token has no Secret), mode 0400, mounted read-only in the workbench only', () => {
    const d = buildDeployment(CFG, TEAM, namesFor(TEAM), { replicas: 1, withDeployer: false }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(d.spec.template.spec.volumes.find((v: { name: string }) => v.name === 'push-run')).toEqual({ name: 'push-run', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } });
    const spec = d.spec.template.spec;
    expect(spec.volumes.find((v: { name: string }) => v.name === 'push')).toEqual({ name: 'push', secret: { secretName: 'hermes-engineering-push', defaultMode: 0o400, optional: true } });
    const mounts = (name: string) => spec.containers.find((c: { name: string }) => c.name === name).volumeMounts;
    expect(mounts('workbench')).toContainEqual({ name: 'push', mountPath: '/etc/workbench-push', readOnly: true });
    expect(mounts('hermes').some((m: { name: string }) => m.name === 'push')).toBe(false);
  });
});
