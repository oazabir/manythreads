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

  describe('one token for every project of a GitHub owner', () => {
    const OWNER = 'github.com/acme';
    const OWNER_KEY = '_owner.github.com.acme';
    const GADGETS = 'https://github.com/acme/gadgets';
    const shared = async (creds: PushCredentials, token = 'owner-token-0123456789') =>
      creds.putShared(TEAM, OWNER, token, [
        { name: 'widgets', origin: ORIGIN, branch: 'main' },
        { name: 'gadgets', origin: GADGETS, branch: 'dev' },
      ]);

    it('keeps the token once under the owner and gives each project only its address, branch and a pointer', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await shared(creds);
      expect(Object.keys(dataOf(k8s)).sort()).toEqual([OWNER_KEY, 'gadgets', 'widgets']);
      const widgets = parsed(dataOf(k8s)['widgets']!) as unknown as Record<string, unknown>;
      expect(widgets).toMatchObject({ origin: ORIGIN, branch: 'main', via: OWNER_KEY });
      expect(widgets['token']).toBeUndefined();
      expect(Object.entries(dataOf(k8s)).filter(([, v]) => Buffer.from(v, 'base64').toString('utf8').includes('owner-token')).map(([k]) => k)).toEqual([OWNER_KEY]); // the token is in one document only
      expect(await creds.read(TEAM, 'widgets')).toEqual({ token: 'owner-token-0123456789', origin: ORIGIN, branch: 'main' });
      expect(await creds.read(TEAM, 'gadgets')).toEqual({ token: 'owner-token-0123456789', origin: GADGETS, branch: 'dev' });
    });

    it('removes the listed projects’ tokens in the same change as it writes the shared one', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await shared(creds);
      await creds.put(TEAM, 'solo', 'solo-token-0123456789', 'https://github.com/other/solo', 'main');
      const writes = k8s.calls.length;
      await creds.putShared(TEAM, OWNER, 'owner-token-0123456789', [{ name: 'widgets', origin: ORIGIN, branch: 'main' }], ['gadgets', 'solo']);
      expect(k8s.calls.length - writes, 'one change of the Secret').toBeLessThanOrEqual(2);
      expect(Object.keys(dataOf(k8s)).sort()).toEqual([OWNER_KEY, 'widgets']);
      await expect(creds.putShared(TEAM, OWNER, 'owner-token-0123456789', [{ name: 'widgets', origin: ORIGIN, branch: 'main' }], ['../x'])).rejects.toThrow('bad project name');
    });

    it('replacing the owner token changes it for every project at once, and clears a refusal', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await shared(creds);
      await creds.setRefused(TEAM, 'widgets', true);
      expect(await creds.read(TEAM, 'gadgets')).toMatchObject({ refused: true });
      await shared(creds, 'owner-token-new-0123456789');
      expect(await creds.read(TEAM, 'gadgets')).toEqual({ token: 'owner-token-new-0123456789', origin: GADGETS, branch: 'dev' });
    });

    it('takes the owner token away with its last project, and not before', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await shared(creds);
      await creds.remove(TEAM, 'widgets');
      expect(Object.keys(dataOf(k8s)).sort()).toEqual([OWNER_KEY, 'gadgets']);
      expect(await creds.read(TEAM, 'gadgets')).toMatchObject({ token: 'owner-token-0123456789' });
      await creds.remove(TEAM, 'gadgets');
      expect(k8s.store.has(SECRET)).toBe(false);
    });

    it('a project given its own token leaves the owner token, which the others keep using', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await shared(creds);
      await creds.put(TEAM, 'widgets', 'own-token-0123456789', ORIGIN, 'main');
      expect(await creds.read(TEAM, 'widgets')).toEqual({ token: 'own-token-0123456789', origin: ORIGIN, branch: 'main' });
      expect(await creds.read(TEAM, 'gadgets')).toMatchObject({ token: 'owner-token-0123456789' });
      await creds.put(TEAM, 'gadgets', 'own-two-0123456789', GADGETS, 'dev');
      expect(Object.keys(dataOf(k8s)).sort()).toEqual(['gadgets', 'widgets']); // nobody points at the owner token any more
    });

    it('marks a refusal on the document that holds the token: the owner’s, so every project on it stops; a project’s own, so only it does', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await shared(creds);
      await creds.put(TEAM, 'solo', 'solo-token-0123456789', 'https://github.com/other/solo', 'main');
      await creds.setRefused(TEAM, 'gadgets', true);
      expect(await creds.read(TEAM, 'widgets')).toMatchObject({ refused: true });
      expect(await creds.read(TEAM, 'solo')).not.toHaveProperty('refused');
      await creds.setRefused(TEAM, 'solo', true);
      expect(await creds.read(TEAM, 'solo')).toMatchObject({ refused: true });
      await creds.setRefused(TEAM, 'widgets', false);
      expect(await creds.read(TEAM, 'gadgets')).not.toHaveProperty('refused');
      await creds.setRefused(TEAM, 'nothing', true); // not an error
      // saving a new token starts clean
      await creds.put(TEAM, 'solo', 'solo-token-new-0123456789', 'https://github.com/other/solo', 'main');
      expect(await creds.read(TEAM, 'solo')).not.toHaveProperty('refused');
    });

    it('prune keeps an owner token that a kept project points at, and drops one nothing points at', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await shared(creds);
      const later = Date.now() + 10 * 60_000;
      expect(await creds.prune(TEAM, new Set(['widgets', 'gadgets']), 120_000, later)).toEqual([]);
      expect(Object.keys(dataOf(k8s)).sort()).toEqual([OWNER_KEY, 'gadgets', 'widgets']);
      expect(await creds.prune(TEAM, new Set(['widgets']), 120_000, later)).toEqual(['gadgets']);
      expect(Object.keys(dataOf(k8s)).sort()).toEqual([OWNER_KEY, 'widgets']);
      expect(await creds.prune(TEAM, new Set(), 120_000, later)).toEqual(['widgets']);
      expect(k8s.store.has(SECRET)).toBe(false);
    });

    it('refuses a bad owner, token, project or an empty list before touching the cluster', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      const one = [{ name: 'widgets', origin: ORIGIN, branch: 'main' }];
      await expect(creds.putShared(TEAM, 'Github.com/Acme', 'owner-token-0123456789', one)).rejects.toThrow('bad owner');
      await expect(creds.putShared(TEAM, 'github.com', 'owner-token-0123456789', one)).rejects.toThrow('bad owner');
      await expect(creds.putShared(TEAM, OWNER, 'two words', one)).rejects.toThrow('bad token');
      await expect(creds.putShared(TEAM, OWNER, 'owner-token-0123456789', [])).rejects.toThrow('no projects');
      await expect(creds.putShared(TEAM, OWNER, 'owner-token-0123456789', [{ name: '_owner.x', origin: ORIGIN, branch: 'main' }])).rejects.toThrow('bad project name');
      await expect(creds.putShared(TEAM, OWNER, 'owner-token-0123456789', [{ name: 'widgets', origin: 'http://github.com/a/b', branch: 'main' }])).rejects.toThrow('bad origin');
      expect(k8s.calls).toEqual([]);
    });
  });

  describe('who the project publishes as', () => {
    const BOT = { provider: 'gitlab', login: 'mt-bot', userId: '4242', commitAs: 'bot' } as const;
    const GITLAB = 'https://gitlab.example.org/group/sub/widgets';
    const doc = (k8s: Store, key: string) => parsed(dataOf(k8s)[key]!) as unknown as Record<string, unknown>;

    it('writes the provider, login, user id and commit-as on the project’s own document, and reads them back as the identity', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await creds.put(TEAM, 'widgets', 'token-one-0123456789', GITLAB, 'main', BOT);
      expect(doc(k8s, 'widgets')).toMatchObject({ provider: 'gitlab', login: 'mt-bot', userId: '4242', commitAs: 'bot', origin: GITLAB });
      expect(await creds.read(TEAM, 'widgets')).toEqual({ token: 'token-one-0123456789', origin: GITLAB, branch: 'main', identity: BOT });
    });

    it('a document written before these fields existed reads with no identity', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await creds.put(TEAM, 'widgets', 'token-one-0123456789', ORIGIN, 'main');
      const d = doc(k8s, 'widgets');
      expect(d['provider']).toBeUndefined();
      expect(d['commitAs']).toBeUndefined();
      expect(await creds.read(TEAM, 'widgets')).toEqual({ token: 'token-one-0123456789', origin: ORIGIN, branch: 'main' });
    });

    it('a shared owner token: every listed project’s own document carries the identity, the owner document only the token', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await creds.putShared(TEAM, 'gitlab.example.org/group', 'owner-token-0123456789', [{ name: 'widgets', origin: GITLAB, branch: 'main' }, { name: 'gadgets', origin: 'https://gitlab.example.org/group/gadgets', branch: 'dev' }], [], BOT);
      const owner = doc(k8s, '_owner.gitlab.example.org.group');
      expect(Object.keys(owner).sort()).toEqual(['setAt', 'token']);
      for (const p of ['widgets', 'gadgets']) expect(doc(k8s, p)).toMatchObject({ provider: 'gitlab', login: 'mt-bot', userId: '4242', commitAs: 'bot', via: '_owner.gitlab.example.org.group' });
      expect(await creds.read(TEAM, 'gadgets')).toEqual({ token: 'owner-token-0123456789', origin: 'https://gitlab.example.org/group/gadgets', branch: 'dev', identity: BOT });
    });

    it('setCommitAs changes only that field of the project’s own document, serialised, and does nothing when absent or unchanged', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      await creds.setCommitAs(TEAM, 'widgets', 'requester');
      expect(k8s.calls).toEqual([]);
      await creds.put(TEAM, 'widgets', 'token-one-0123456789', GITLAB, 'main', BOT);
      const before = dataOf(k8s)['widgets'];
      await creds.setCommitAs(TEAM, 'widgets', 'bot');
      expect(dataOf(k8s)['widgets']).toBe(before);
      await creds.setCommitAs(TEAM, 'widgets', 'requester');
      expect(doc(k8s, 'widgets')).toMatchObject({ commitAs: 'requester', login: 'mt-bot', token: 'token-one-0123456789' });
      expect((await creds.read(TEAM, 'widgets'))?.identity).toEqual({ ...BOT, commitAs: 'requester' });
      // on an owner token the owner document is left alone
      await creds.putShared(TEAM, 'gitlab.example.org/group', 'owner-token-0123456789', [{ name: 'gadgets', origin: 'https://gitlab.example.org/group/gadgets', branch: 'dev' }], [], BOT);
      const owner = dataOf(k8s)['_owner.gitlab.example.org.group'];
      await creds.setCommitAs(TEAM, 'gadgets', 'requester');
      expect(dataOf(k8s)['_owner.gitlab.example.org.group']).toBe(owner);
      expect((await creds.read(TEAM, 'gadgets'))?.identity?.commitAs).toBe('requester');
      await expect(creds.setCommitAs(TEAM, 'widgets', 'someone' as 'bot')).rejects.toThrow('bad commit as');
    });

    it('refuses a bad provider, login, user id or commit-as before touching the cluster, with a message that does not hold the token', async () => {
      const k8s = new Store();
      const creds = new PushCredentials(() => k8s, { namespace: NS });
      const tok = 'token-one-0123456789';
      for (const [bad, why] of [
        [{ ...BOT, provider: 'bitbucket' }, 'bad provider'],
        [{ ...BOT, login: '-x' }, 'bad login'],
        [{ ...BOT, login: 'a b' }, 'bad login'],
        [{ ...BOT, login: 'a'.repeat(256) }, 'bad login'],
        [{ ...BOT, userId: '12x' }, 'bad user id'],
        [{ ...BOT, userId: '1'.repeat(21) }, 'bad user id'],
        [{ ...BOT, commitAs: 'nobody' }, 'bad commit as'],
      ] as const) {
        const err = await creds.put(TEAM, 'widgets', tok, ORIGIN, 'main', bad as never).catch((e: unknown) => e as Error);
        expect((err as Error).message).toBe(why);
        expect((err as Error).message).not.toContain(tok);
        await expect(creds.putShared(TEAM, 'github.com/acme', tok, [{ name: 'widgets', origin: ORIGIN, branch: 'main' }], [], bad as never)).rejects.toThrow(why);
      }
      expect(k8s.calls).toEqual([]);
    });
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
