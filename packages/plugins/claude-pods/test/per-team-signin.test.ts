/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read parsed JSON documents whose shape the assertions then pin */
import type { PluginLogger, PodRunnerInfo, PodRunnerState } from '@manythreads/sdk';
import type { K8s, K8sObject } from '@manythreads/sdk/pods';
import { describe, expect, it } from 'vitest';
import { configFrom, type ClaudePodConfig } from '../src/config.ts';
import { providerFor } from '../src/index.ts';
import { Reconciler, type RunnerSource } from '../src/reconcile.ts';
import { buildDeployment, namesFor, runnerForTeam, type PodRunner } from '../src/render.ts';

// P35-10a (docs/plans/per-team-sign-in.md sections 3 and 7): a runner where each team signs in gives each team pod a sign-in volume of its own, `<team pod>-signin`, labelled with the
// team's id, instead of the runner's one shared `-state` volume. The uploaded sign-in file and its keeper are not used. Switching the scope deletes the other scope's volumes.

class FakeK8s implements K8s {
  readonly store = new Map<string, K8sObject>();
  nodes: K8sObject[] = [];
  readonly deleted: string[] = [];
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
    this.deleted.push(`${kind}/${name}`);
    this.store.delete(this.key(kind, ns, name));
  }
  async list(kind: string, ns: string, selector: string): Promise<K8sObject[]> {
    const wanted = selector.split(',').map((s) => s.split('='));
    return [...this.store.values()].filter((o) => o.kind === kind && o.metadata.namespace === ns && wanted.every(([k, v]) => o.metadata.labels?.[k!] === v));
  }
  async annotate(kind: string, ns: string, name: string, annotations: Record<string, string | null>): Promise<void> {
    const o = this.store.get(this.key(kind, ns, name));
    if (o) o.metadata.annotations = { ...(o.metadata.annotations ?? {}), ...(Object.fromEntries(Object.entries(annotations).filter(([, v]) => v !== null)) as Record<string, string>) };
  }
  async listNodes(): Promise<K8sObject[]> {
    return this.nodes;
  }
  claims(): string[] {
    return [...this.store.values()].filter((o) => o.kind === 'PersistentVolumeClaim').map((o) => o.metadata.name).sort();
  }
}

const CFG: ClaudePodConfig = { ...configFrom({}), namespace: 'bots', image: 'manythreads/claude-pod:1', repoOriginAllow: [] };
const logs: string[] = [];
const LOG: PluginLogger = { info: (m) => void logs.push(m), warn: (m) => void logs.push(`WARN ${m}`) };

const ENG = { id: '00000000-0000-4000-8000-00000000e001', slug: 'engineering' };
const MKT = { id: '00000000-0000-4000-8000-00000000e002', slug: 'marketing' };
const RUNNER_ID = '00000000-0000-4000-8000-0000000000a1';

const runner = (over: Partial<PodRunnerInfo> = {}, agent: 'claude' | 'codex' = 'claude'): PodRunner => ({
  id: RUNNER_ID,
  workspaceId: 'w1',
  name: 'each',
  enabled: true,
  node: null,
  maxConcurrent: null,
  teams: [ENG, MKT],
  allTeams: false,
  bots: [
    { teamId: ENG.id, teamSlug: ENG.slug, botSlug: 'engineer' },
    { teamId: MKT.id, teamSlug: MKT.slug, botSlug: 'writer' },
  ],
  signInScope: 'per_team',
  agent,
  ...over,
});

function setup(list: () => PodRunner[], doFetch: typeof fetch = (async () => new Response('', { status: 503 })) as typeof fetch) {
  const k8s = new FakeK8s();
  const reports: PodRunnerState[] = [];
  const source: RunnerSource = { runners: async () => list(), report: async (s) => void reports.push(s) };
  let n = 0;
  return { k8s, reports, r: new Reconciler(k8s, CFG, source, LOG, () => `key-${++n}`.padEnd(48, '0'), () => 1_000_000, doFetch) };
}
const podRunning = (k8s: FakeK8s, podBase: string): void => {
  k8s.store.set(`Pod/bots/${podBase}-1`, { apiVersion: 'v1', kind: 'Pod', metadata: { name: `${podBase}-1`, namespace: 'bots', labels: { 'manythreads.io/pod': podBase, 'manythreads.io/runner-id': RUNNER_ID } }, status: { phase: 'Running' } });
};
const dep = (k8s: FakeK8s, team: string, agent: 'claude' | 'codex' = 'claude'): any => k8s.store.get(`Deployment/bots/${namesFor('each', agent, team).base}`)!;
const stateVolume = (d: any): string => d.spec.template.spec.volumes.find((v: any) => v.name === 'state').persistentVolumeClaim.claimName;

describe('render: a team pod with a sign-in volume of its own', () => {
  it('names the claim after the team pod with -signin, never -state, and mounts it at /state', () => {
    const names = namesFor('each', 'claude', 'engineering');
    expect(names.signin).toBe('claude-each-engineering-signin');
    expect(names.state).toBe('claude-each-state');
    // runner `each` with team `engineering` and a runner called `each-engineering` would both spell `claude-each-engineering-state`: the per-team claim never ends in -state
    expect(names.signin).not.toBe(namesFor('each-engineering').state);
    const d = buildDeployment(CFG, runnerForTeam(runner(), ENG), names, { replicas: 1, keeper: false, signinFile: false, stateClaim: names.signin });
    expect(stateVolume(d)).toBe('claude-each-engineering-signin');
    // the shared shape is unchanged
    expect(stateVolume(buildDeployment(CFG, runnerForTeam(runner(), ENG), names, { replicas: 1, keeper: false }))).toBe('claude-each-state');
  });
});

describe('reconcile: each team signs in', () => {
  it('makes one sign-in claim per team pod, labelled with the team id, and no shared state claim; each Deployment mounts its own', async () => {
    const { k8s, r } = setup(() => [runner()]);
    await r.reconcileAll();
    expect(k8s.claims()).toEqual(['claude-each-engineering-signin', 'claude-each-engineering-work', 'claude-each-marketing-signin', 'claude-each-marketing-work']);
    const eng = k8s.store.get('PersistentVolumeClaim/bots/claude-each-engineering-signin')!;
    expect(eng.metadata.labels).toMatchObject({ 'manythreads.io/runner-id': RUNNER_ID, 'manythreads.io/team-id': ENG.id, 'manythreads.io/team': 'engineering' });
    expect(stateVolume(dep(k8s, 'engineering'))).toBe('claude-each-engineering-signin');
    expect(stateVolume(dep(k8s, 'marketing'))).toBe('claude-each-marketing-signin');
    // two pods with volumes of their own share none, so nothing pins them to one machine
    expect(dep(k8s, 'engineering').spec.template.spec.nodeSelector).toBeUndefined();
  });

  it('ignores an uploaded sign-in file and its keeper', async () => {
    const { k8s, r } = setup(() => [runner()]);
    const shared = namesFor('each');
    k8s.store.set(`Secret/bots/${shared.credentials}`, { apiVersion: 'v1', kind: 'Secret', metadata: { name: shared.credentials, namespace: 'bots' }, data: { '.credentials.json': 'eA==', 'upload-id': Buffer.from('up-1').toString('base64') } });
    await r.reconcileAll();
    for (const team of ['engineering', 'marketing']) {
      const spec = dep(k8s, team).spec.template.spec;
      expect(spec.containers.map((c: any) => c.name)).not.toContain('keeper');
      expect(spec.volumes.map((v: any) => v.name)).not.toContain('creds');
      expect(spec.serviceAccountName).toBeUndefined();
      expect(dep(k8s, team).spec.replicas).toBe(1);
    }
    expect(k8s.store.has(`ServiceAccount/bots/${shared.keeper}`)).toBe(false);
  });

  it('switching shared -> per team deletes the shared state claim, and per team -> shared deletes every team claim', async () => {
    let scope: 'shared' | 'per_team' = 'shared';
    const { k8s, r } = setup(() => [runner({ signInScope: scope })]);
    await r.reconcileAll();
    expect(k8s.claims()).toEqual(['claude-each-engineering-work', 'claude-each-marketing-work', 'claude-each-state']);
    expect(stateVolume(dep(k8s, 'engineering'))).toBe('claude-each-state');

    scope = 'per_team';
    await r.reconcileAll();
    expect(k8s.deleted).toContain('PersistentVolumeClaim/claude-each-state');
    expect(k8s.claims()).toEqual(['claude-each-engineering-signin', 'claude-each-engineering-work', 'claude-each-marketing-signin', 'claude-each-marketing-work']);
    expect(stateVolume(dep(k8s, 'marketing'))).toBe('claude-each-marketing-signin');

    scope = 'shared';
    await r.reconcileAll();
    expect(k8s.deleted).toEqual(expect.arrayContaining(['PersistentVolumeClaim/claude-each-engineering-signin', 'PersistentVolumeClaim/claude-each-marketing-signin']));
    expect(k8s.claims()).toEqual(['claude-each-engineering-work', 'claude-each-marketing-work', 'claude-each-state']);
    expect(stateVolume(dep(k8s, 'engineering'))).toBe('claude-each-state');
  });

  it('deletes the sign-in claim of a team that left the runner, and keeps one of a team that only has no bot right now', async () => {
    let over: Partial<PodRunnerInfo> = {};
    const { k8s, r } = setup(() => [runner(over)]);
    await r.reconcileAll();
    // marketing has no bot any more but stays on the list: its pod stops, its sign-in stays
    over = { bots: [{ teamId: ENG.id, teamSlug: ENG.slug, botSlug: 'engineer' }] };
    await r.reconcileAll();
    expect(k8s.claims()).toContain('claude-each-marketing-signin');
    expect(dep(k8s, 'marketing').spec.replicas).toBe(0);
    // marketing leaves the list: its sign-in goes
    over = { teams: [ENG], bots: [{ teamId: ENG.id, teamSlug: ENG.slug, botSlug: 'engineer' }] };
    await r.reconcileAll();
    expect(k8s.claims()).not.toContain('claude-each-marketing-signin');
    expect(k8s.claims()).toContain('claude-each-engineering-signin');
  });

  it('never mounts a sign-in claim of another team id (a slug used again): the old team\'s claim is deleted, and the pod waits while it is going', async () => {
    const { k8s, r } = setup(() => [runner()]);
    const stale = (extra: Record<string, unknown> = {}): K8sObject => ({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'claude-each-marketing-signin', namespace: 'bots', labels: { 'manythreads.io/runner-id': RUNNER_ID, 'manythreads.io/team-id': '00000000-0000-4000-8000-0000000000ff' }, ...extra },
    });
    // still being deleted: the new marketing team gets no pod on it this pass
    k8s.store.set('PersistentVolumeClaim/bots/claude-each-marketing-signin', stale({ deletionTimestamp: '2026-11-24T00:00:00Z' }));
    await r.reconcileAll();
    expect(k8s.store.has('Deployment/bots/claude-each-marketing')).toBe(false);
    expect(k8s.store.has('Deployment/bots/claude-each-engineering')).toBe(true);
    expect(logs.some((l) => l.includes('claude-each-marketing-signin belongs to another runner or team'))).toBe(true);
    // not being deleted yet: the controller deletes it (its team is not on the list), and the new team's claim carries the new team's id
    k8s.store.set('PersistentVolumeClaim/bots/claude-each-marketing-signin', stale());
    await r.reconcileAll();
    expect(k8s.deleted).toContain('PersistentVolumeClaim/claude-each-marketing-signin');
    expect(k8s.store.get('PersistentVolumeClaim/bots/claude-each-marketing-signin')!.metadata.labels?.['manythreads.io/team-id']).toBe(MKT.id);
  });

  it("reports each team's own state from its own pod, and is ready while one team is signed in; a pod that does not answer is left out", async () => {
    const asked: string[] = [];
    const doFetch = (async (url: string) => {
      asked.push(String(url));
      if (String(url).includes('claude-each-engineering')) return new Response(JSON.stringify({ auth: { state: 'signed_in' } }), { status: 200 });
      if (String(url).includes('claude-each-marketing')) return new Response(JSON.stringify({ auth: { state: 'signed_out' } }), { status: 200 });
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    const { k8s, reports, r } = setup(() => [runner({ teams: [ENG, MKT, { id: '00000000-0000-4000-8000-00000000e003', slug: 'support' }], bots: [...runner().bots, { teamId: '00000000-0000-4000-8000-00000000e003', teamSlug: 'support', botSlug: 'helper' }] })], doFetch);
    await r.reconcileAll();
    podRunning(k8s, 'claude-each-engineering');
    podRunning(k8s, 'claude-each-marketing');
    // support's pod is not running: it is not asked, and nothing is said about it
    const [res] = await r.reconcileAll();
    expect(res!.state).toBe('ready');
    expect(reports.at(-1)).toMatchObject({ status: 'ready', teams: [{ teamId: ENG.id, state: 'signed_in' }, { teamId: MKT.id, state: 'signed_out' }] });
    expect(asked.filter((u) => u.includes('/v1/auth/status')).length).toBe(2);
  });

  it('waits for a sign-in while no team is signed in, and a shared runner reports no team states', async () => {
    const out = (async () => new Response(JSON.stringify({ auth: { state: 'signed_out' } }), { status: 200 })) as unknown as typeof fetch;
    const { k8s, reports, r } = setup(() => [runner()], out);
    await r.reconcileAll();
    podRunning(k8s, 'claude-each-engineering');
    expect((await r.reconcileAll())[0]!.state).toBe('waiting_for_sign_in');
    const shared = setup(() => [runner({ signInScope: 'shared' })], out);
    await shared.r.reconcileAll();
    expect(shared.reports.at(-1)!.teams).toBeUndefined();
    expect(reports.at(-1)!.teams).toEqual([{ teamId: ENG.id, state: 'signed_out' }]);
  });

  it('makes the first pod (no bot yet) for the first team in code-unit order, the rule bot-runners uses for the served team', async () => {
    const AZ = { id: '00000000-0000-4000-8000-00000000e00a', slug: 'a-z' };
    const AB = { id: '00000000-0000-4000-8000-00000000e00b', slug: 'ab' };
    const { r } = setup(() => [runner({ teams: [AB, AZ], bots: [] })]);
    const [res] = await r.reconcileAll();
    // "a-z" < "ab" by code units ('-' is 0x2d); bot-runners' markServed and oneTeam (COLLATE "C") pick the same one (test/claude-runner.test.ts)
    expect(res!.pods).toEqual(['claude-each-a-z']);
  });

  it('asks the team pods at once, not one after another', async () => {
    let inFlight = 0;
    let most = 0;
    const doFetch = (async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((res) => setTimeout(res, 30));
      inFlight -= 1;
      return new Response(JSON.stringify({ auth: { state: 'signed_in' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { k8s, r } = setup(() => [runner()], doFetch);
    await r.reconcileAll();
    podRunning(k8s, 'claude-each-engineering');
    podRunning(k8s, 'claude-each-marketing');
    most = 0;
    await r.reconcileAll();
    expect(most).toBe(2);
  });

  it('signs a team that left the runner out through its pod before its sign-in volume is deleted', async () => {
    const calls: string[] = [];
    const doFetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify({ auth: { state: 'signed_out' } }), { status: 200 });
    }) as unknown as typeof fetch;
    let over: Partial<PodRunnerInfo> = {};
    const { k8s, r } = setup(() => [runner(over)], doFetch);
    await r.reconcileAll();
    podRunning(k8s, 'claude-each-marketing');
    over = { teams: [ENG], bots: [{ teamId: ENG.id, teamSlug: ENG.slug, botSlug: 'engineer' }] };
    calls.length = 0;
    await r.reconcileAll();
    const logout = calls.findIndex((c) => c === 'POST http://claude-each-marketing.bots.svc:8650/v1/auth/logout?agent=claude-code');
    expect(logout).toBeGreaterThanOrEqual(0);
    expect(k8s.deleted).toContain('PersistentVolumeClaim/claude-each-marketing-signin');
  });

  it('has no placeholder pod: with no team on the list there is nothing to sign in', async () => {
    const { k8s, r } = setup(() => [runner({ teams: [], bots: [] })]);
    const [res] = await r.reconcileAll();
    expect(res!.pods).toEqual([]);
    expect(k8s.claims()).toEqual([]);
  });

  it('moves the team sign-in claims with the work claims (an admin-confirmed move deletes both)', async () => {
    let node: string | null = null;
    const { k8s, r } = setup(() => [runner({ node })]);
    await r.reconcileAll();
    for (const c of k8s.claims()) k8s.store.get(`PersistentVolumeClaim/bots/${c}`)!.metadata.annotations = { 'manythreads.io/node': 'vm-a' };
    k8s.nodes = [{ apiVersion: 'v1', kind: 'Node', metadata: { name: 'vm-b', labels: { 'kubernetes.io/hostname': 'vm-b' } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }];
    node = 'vm-b';
    const p = providerFor(() => r, () => k8s, CFG, () => 1_000_000);
    expect(await p.confirmMove({ runnerId: RUNNER_ID, node: 'vm-b' })).toBe(4);
    await r.reconcileAll(); // stops the pods (moving)
    for (const key of [...k8s.store.keys()]) if (key.startsWith('Pod/')) k8s.store.delete(key);
    await r.reconcileAll(); // no pod left: the claims are deleted
    expect(k8s.deleted).toEqual(expect.arrayContaining(['PersistentVolumeClaim/claude-each-engineering-signin', 'PersistentVolumeClaim/claude-each-marketing-signin', 'PersistentVolumeClaim/claude-each-engineering-work']));
  });
});

describe('the provider', () => {
  it("answers a team's own pod, checks a team's sign-in on that pod, and removes only this runner's team sign-in claims", async () => {
    const { k8s, r } = setup(() => [runner()]);
    await r.reconcileAll();
    // another runner's claim of the same shape is never touched
    k8s.store.set('PersistentVolumeClaim/bots/claude-other-engineering-signin', { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'claude-other-engineering-signin', namespace: 'bots', labels: { 'app.kubernetes.io/managed-by': 'manythreads-claude-pods', 'manythreads.io/runner-id': 'someone-else' } } });
    const asked: string[] = [];
    const doFetch = (async (url: string) => (asked.push(String(url)), new Response(JSON.stringify({ result: 'ok' }), { status: 200 }))) as unknown as typeof fetch;
    const p = providerFor(() => r, () => k8s, CFG, Date.now, doFetch);
    expect((await p.bridge({ runnerName: 'each', agent: 'claude', teamSlug: 'marketing' }))?.address).toBe('http://claude-each-marketing.bots.svc:8650');
    expect(await p.checkSignin({ runnerName: 'each', agent: 'claude', teamSlug: 'marketing' })).toBe('ok');
    expect(asked).toEqual(['http://claude-each-marketing.bots.svc:8650/v1/signin/check']);
    podRunning(k8s, 'claude-each-marketing');
    expect(await p.removeTeamSignins({ runnerId: RUNNER_ID, teamId: MKT.id })).toBe(1);
    // the running pod was signed out first, with its own key
    expect(asked.at(-1)).toBe('http://claude-each-marketing.bots.svc:8650/v1/auth/logout?agent=claude-code');
    expect(k8s.claims()).toEqual(['claude-each-engineering-signin', 'claude-each-engineering-work', 'claude-each-marketing-work', 'claude-other-engineering-signin']);
    expect(await p.removeTeamSignins({ runnerId: RUNNER_ID })).toBe(1);
    expect(k8s.claims()).toEqual(['claude-each-engineering-work', 'claude-each-marketing-work', 'claude-other-engineering-signin']);
  });
});
