/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { startFakeK8s, TEAM_IDS, type FakeK8s } from '@manythreads/test-utils';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type World } from './world.ts';

// Choosing the machine a pod runner stands on (P19-08), over HTTP on a real server and database. The cluster is a local double of the Kubernetes API that
// answers the node, pod, Deployment and volume-claim lists: the real node-lister (hermes-pods) reads it, so the whole path is run without a cluster.

const { omar, nadia, tariq } = personas;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let w: World;
let k8s: FakeK8s;
const saved: Record<string, string | undefined> = {};
const ENV = ['MANYTHREADS_HERMES_PODS_TEST_K8S_URL', 'MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES'];

const node = (name: string, over: { ready?: boolean; cordoned?: boolean } = {}): Record<string, unknown> => ({
  apiVersion: 'v1',
  kind: 'Node',
  metadata: { name, labels: { 'kubernetes.io/hostname': name } },
  spec: over.cordoned ? { unschedulable: true } : {},
  status: { conditions: [{ type: 'Ready', status: over.ready === false ? 'False' : 'True' }], allocatable: { cpu: '4', memory: '16Gi' }, nodeInfo: { architecture: 'amd64' } },
});
const POD_LABELS = (team: string): Record<string, string> => ({
  'app.kubernetes.io/component': 'hermes-pod',
  'app.kubernetes.io/managed-by': 'manythreads-hermes-pods',
  'manythreads.io/team-id': team,
});
const adminCreate = (body: Record<string, unknown>) => w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', body);

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_HERMES_PODS_TEST_K8S_URL'] = k8s.url;
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w?.close();
  await k8s?.stop();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  delete process.env['MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES'];
  k8s.nodes.splice(0, k8s.nodes.length, node('ubuntu-vm'), node('worker-2'), node('worker-3', { ready: false }), node('worker-4', { cordoned: true }));
  k8s.pods.length = 0;
  k8s.deployments.length = 0;
  k8s.claims.length = 0;
});

describe('the list of machines', () => {
  it('lists the machines with their state, architecture and what they offer, to an admin only', async () => {
    const res = await w.call<any>(omar, 'GET', '/api/admin/bot-runners/nodes');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ available: true, singleNode: false, placement: null, note: null });
    expect(res.body.nodes.map((n: any) => [n.name, n.ready])).toEqual([
      ['ubuntu-vm', true],
      ['worker-2', true],
      ['worker-3', false],
      ['worker-4', false],
    ]);
    expect(res.body.nodes[0]).toMatchObject({ architecture: 'amd64', cpuAllocatableMillis: 4000, memoryAllocatableBytes: 16 * 1024 ** 3, hasWorkVolume: false, workVolumes: 0 });
    for (const who of [tariq, nadia]) {
      const refused = await w.call<any>(who, 'GET', '/api/admin/bot-runners/nodes');
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain('ubuntu-vm');
    }
    expect((await w.call(null, 'GET', '/api/admin/bot-runners/nodes')).status).toBe(401);
  });

  it('lists only the machines the operator allows (the Helm value botRunners.allowedNodes)', async () => {
    process.env['MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES'] = 'ubuntu-vm, worker-3';
    const res = await w.call<any>(omar, 'GET', '/api/admin/bot-runners/nodes');
    expect(res.body.nodes.map((n: any) => n.name)).toEqual(['ubuntu-vm', 'worker-3']);
    expect(res.body.singleNode).toBe(false);
  });

  it('a one-machine install shows its one machine and says so', async () => {
    k8s.nodes.splice(0, k8s.nodes.length, node('ubuntu-vm'));
    const res = await w.call<any>(omar, 'GET', '/api/admin/bot-runners/nodes');
    expect(res.body.nodes.map((n: any) => n.name)).toEqual(['ubuntu-vm']);
    expect(res.body.singleNode).toBe(true);
  });

  it('says plainly when the cluster does not answer, without anything it said', async () => {
    k8s.failNext(1);
    const res = await w.call<any>(omar, 'GET', '/api/admin/bot-runners/nodes');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false, nodes: [], singleNode: false });
    expect(res.body.note).toContain('did not answer');
    expect(JSON.stringify(res.body)).not.toContain('forced failure');
  });

  it('refuses a runner that is not a pod runner, and an unknown id', async () => {
    const llm = await adminCreate({ name: 'model', label: 'Model', kind: 'llm_gateway', modelAlias: 'fast' });
    const res = await w.call<any>(omar, 'GET', `/api/admin/bot-runners/nodes?runnerId=${llm.body.runner.id}`);
    expect(res.status).toBe(400);
    expect((await w.call(omar, 'GET', '/api/admin/bot-runners/nodes?runnerId=00000000-0000-7000-8000-00000000dead')).status).toBe(404);
  });
});

describe('choosing a machine for a pod runner', () => {
  let id = '';
  const events = async (): Promise<any[]> =>
    w.system(async (tx) => (await tx.query<{ payload: any }>("SELECT payload FROM app.events WHERE type = 'bot_runner.node.changed' ORDER BY id")).rows.map((r) => r.payload));

  beforeAll(async () => {
    id = (await adminCreate({ name: 'team-pod', label: 'Team Hermes pod', kind: 'hermes_pod', teams: { teams: [TEAM_IDS.Engineering] } })).body.runner.id;
  });

  it('refuses a machine outside the operator\'s list, and a machine that does not exist, with the same words', async () => {
    process.env['MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES'] = 'ubuntu-vm';
    const outside = await w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'worker-2' });
    const missing = await w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'no-such-machine' });
    expect(outside.status).toBe(400);
    expect(missing.status).toBe(400);
    const said = (r: any): unknown => r.body.message ?? r.body.error?.message;
    expect(typeof said(outside)).toBe('string');
    expect((said(outside) as string).length).toBeGreaterThan(0);
    expect(said(outside)).toBe(said(missing));
    const row = await w.system(async (tx) => (await tx.query<{ node: string | null }>('SELECT node FROM app.bot_runners WHERE id = $1', [id])).rows[0]);
    expect(row?.node).toBeNull();
    expect(await events()).toEqual([]);
  });

  it('refuses a machine that is not Ready, or that is cordoned', async () => {
    for (const name of ['worker-3', 'worker-4']) {
      const res = await w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: name });
      expect(res.status, name).toBe(409);
      expect(JSON.stringify(res.body)).toContain('not Ready');
    }
    expect(await events()).toEqual([]);
  });

  it('refuses a name that is not a machine name, an extra field, and anyone who is not an admin', async () => {
    expect((await w.call(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'a b' })).status).toBe(400);
    expect((await w.call(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'ubuntu-vm', extra: 1 })).status).toBe(400);
    for (const who of [tariq, nadia]) expect((await w.call(who, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'ubuntu-vm' })).status).toBe(403);
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${id}`, { node: 'ubuntu-vm' })).status).toBe(400);
  });

  it('refuses a runner that is not a pod runner', async () => {
    const llm = await adminCreate({ name: 'model2', label: 'Model two', kind: 'llm_gateway', modelAlias: 'fast' });
    expect((await w.call(omar, 'PUT', `/api/admin/bot-runners/${llm.body.runner.id}/node`, { node: 'ubuntu-vm' })).status).toBe(400);
  });

  it('stores a Ready allowed machine, writes one event with no machine name in it, and keeps the Teams list', async () => {
    const res = await w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'ubuntu-vm' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runner).toMatchObject({ id, node: 'ubuntu-vm' });
    expect(res.body.runner.teams.map((t: any) => t.teamId)).toEqual([TEAM_IDS.Engineering]);
    expect(res.body.recreatesWorkVolume).toBe(false);
    const list = await w.call<any>(omar, 'GET', '/api/admin/bot-runners');
    expect(list.body.items.find((r: any) => r.id === id).node).toBe('ubuntu-vm');
    const sent = await events();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ runnerId: id, name: 'team-pod', wasPinned: false, isPinned: true, recreatesWorkVolume: false });
    expect(JSON.stringify(sent)).not.toContain('ubuntu-vm');
    // the audit row is made from the event by the audit plugin; a query that fails fails the test
    const auditRows = async (): Promise<{ action: string; reason: string | null; target_label: string | null }[]> =>
      w.system(async (tx) => (await tx.query<{ action: string; reason: string | null; target_label: string | null }>("SELECT action, reason, target_label FROM app.audit_events WHERE action = 'bot_runner.node_changed' ORDER BY id")).rows);
    await expect.poll(async () => (await auditRows()).length, { timeout: 15_000 }).toBe(1);
    expect(JSON.stringify(await auditRows())).not.toContain('ubuntu-vm');
    expect((await auditRows())[0]).toMatchObject({ reason: 'A machine was chosen', target_label: 'team-pod' });
    // the same node again changes nothing and writes nothing
    const again = await w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'ubuntu-vm' });
    expect(again.status).toBe(200);
    expect(await events()).toHaveLength(1);
  });

  it('says a move will recreate the work volume when a pod keeps it on another machine, and a team member never sees the machine', async () => {
    k8s.claims.push({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'hermes-engineering-workspace', namespace: 'manythreads-bots', labels: POD_LABELS(TEAM_IDS.Engineering), annotations: { 'volume.kubernetes.io/selected-node': 'ubuntu-vm' } },
    });
    const nodes = await w.call<any>(omar, 'GET', `/api/admin/bot-runners/nodes?runnerId=${id}`);
    expect(nodes.body.nodes.find((n: any) => n.name === 'ubuntu-vm')).toMatchObject({ hasWorkVolume: true, workVolumes: 1 });
    expect(nodes.body.nodes.find((n: any) => n.name === 'worker-2')).toMatchObject({ hasWorkVolume: false });
    const res = await w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'worker-2' });
    expect(res.status).toBe(200);
    expect(res.body.recreatesWorkVolume).toBe(true);
    const last = (await events()).at(-1);
    expect(last).toMatchObject({ wasPinned: true, isPinned: true, recreatesWorkVolume: true });
    // the admin's confirmation was written on the claim, for the machine chosen and nothing else
    const mark = (k8s.claims[0] as any).metadata.annotations['manythreads.io/move-confirmed'] as string;
    expect(mark.startsWith('worker-2@')).toBe(true);
    const team = await w.call<any>(tariq, 'GET', '/api/teams/engineering/bot-runners');
    expect(JSON.stringify(team.body)).not.toContain('worker-2');
  });

  it('clears the machine with null, even with no cluster to ask', async () => {
    const res = await w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: null });
    expect(res.status).toBe(200);
    expect(res.body.runner.node).toBeNull();
    expect((await events()).at(-1)).toMatchObject({ wasPinned: true, isPinned: false, recreatesWorkVolume: false });
  });

  it('shows where the pods stand: idle, running, waiting because the machine is not Ready, and moving', async () => {
    const place = async (): Promise<any> => (await w.call<any>(omar, 'GET', `/api/admin/bot-runners/nodes?runnerId=${id}`)).body.placement;
    expect(await place()).toEqual({ state: 'idle', node: null, reason: null });

    expect((await w.call(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node: 'ubuntu-vm' })).status).toBe(200);
    expect(await place()).toEqual({ state: 'idle', node: 'ubuntu-vm', reason: null });

    k8s.pods.push({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'hermes-engineering-a', labels: POD_LABELS(TEAM_IDS.Engineering) }, spec: { nodeName: 'ubuntu-vm' }, status: { phase: 'Running' } });
    expect(await place()).toEqual({ state: 'running', node: 'ubuntu-vm', reason: null });

    // the machine goes NotReady and the pod is replaced: it cannot be placed
    k8s.pods.length = 0;
    k8s.nodes.splice(0, 1, node('ubuntu-vm', { ready: false }));
    k8s.pods.push({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'hermes-engineering-b', labels: POD_LABELS(TEAM_IDS.Engineering) },
      spec: {},
      status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'node(s) had untolerated taint 10.0.0.5' }] },
    });
    const waiting = await place();
    expect(waiting).toEqual({ state: 'waiting', node: 'ubuntu-vm', reason: 'node_not_ready' });
    // nothing the cluster said about the pod is passed on
    expect(JSON.stringify(await w.call(omar, 'GET', `/api/admin/bot-runners/nodes?runnerId=${id}`))).not.toContain('10.0.0.5');

    // the machine is back but the pod is moving (volumes being recreated)
    k8s.nodes.splice(0, 1, node('ubuntu-vm'));
    k8s.pods.length = 0;
    k8s.deployments.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'hermes-engineering', labels: POD_LABELS(TEAM_IDS.Engineering), annotations: { 'manythreads.io/moving': 'ubuntu-vm' } } });
    expect(await place()).toEqual({ state: 'moving', node: 'ubuntu-vm', reason: null });
  });

  it('with no cluster behind the server, listing says so and naming a machine is refused (clearing still works)', async () => {
    // a second server without the cluster double: the provider is absent
    const keep = process.env['MANYTHREADS_HERMES_PODS_TEST_K8S_URL'];
    delete process.env['MANYTHREADS_HERMES_PODS_TEST_K8S_URL'];
    const lone = await createWorld();
    try {
      const listed = await lone.call<any>(omar, 'GET', '/api/admin/bot-runners/nodes');
      expect(listed.body).toMatchObject({ available: false, nodes: [] });
      expect(listed.body.note).toContain('no cluster');
      const pod = await lone.call<any>(omar, 'POST', '/api/admin/bot-runners', { name: 'team-pod', label: 'Pod', kind: 'hermes_pod' });
      const named = await lone.call<any>(omar, 'PUT', `/api/admin/bot-runners/${pod.body.runner.id}/node`, { node: 'ubuntu-vm' });
      expect(named.status).toBe(409);
      expect((await lone.call(omar, 'PUT', `/api/admin/bot-runners/${pod.body.runner.id}/node`, { node: null })).status).toBe(200);
    } finally {
      await lone.close();
      if (keep !== undefined) process.env['MANYTHREADS_HERMES_PODS_TEST_K8S_URL'] = keep;
    }
  });
});

describe('a move is confirmed only by the admin who chose it, and only for the teams the runner decides (P19-08)', () => {
  const claim = (team: string, name: string, at: string): Record<string, unknown> => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: 'manythreads-bots', labels: POD_LABELS(team), annotations: { 'volume.kubernetes.io/selected-node': at } },
  });
  const put = (id: string, node: string | null) => w.call<any>(omar, 'PUT', `/api/admin/bot-runners/${id}/node`, { node });
  const marks = (): string[] => k8s.claims.map((c: any) => `${c.metadata.name}=${c.metadata.annotations['manythreads.io/move-confirmed'] ?? '-'}`.replace(/@\d+/, '@T'));
  const events = async (): Promise<any[]> =>
    w.system(async (tx) => (await tx.query<{ payload: any }>("SELECT payload FROM app.events WHERE type = 'bot_runner.node.changed' ORDER BY id")).rows.map((r) => r.payload));
  let a = '';
  let b = '';

  beforeAll(async () => {
    // two pod runners: "alpha-pod" (sorts first) for Engineering and Marketing, "beta-pod" for Marketing only
    a = (await adminCreate({ name: 'alpha-pod', label: 'Alpha', kind: 'hermes_pod', teams: { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] } })).body.runner.id;
    b = (await adminCreate({ name: 'beta-pod', label: 'Beta', kind: 'hermes_pod', teams: { teams: [TEAM_IDS.Marketing] } })).body.runner.id;
  });

  it('marks the claims of the teams the runner decides, not the ones another runner outranks it for', async () => {
    k8s.claims.push(claim(TEAM_IDS.Engineering, 'hermes-engineering-workspace', 'ubuntu-vm'), claim(TEAM_IDS.Engineering, 'hermes-engineering-home', 'ubuntu-vm'));
    k8s.claims.push(claim(TEAM_IDS.Marketing, 'hermes-marketing-workspace', 'ubuntu-vm'));
    // alpha-pod has no machine yet and beta-pod pins Marketing to worker-2: alpha-pod decides the machine of Engineering only once it has one, and of Marketing never
    expect((await put(b, 'worker-2')).body.recreatesWorkVolume).toBe(true);
    expect(marks()).toEqual(['hermes-engineering-workspace=-', 'hermes-engineering-home=-', 'hermes-marketing-workspace=worker-2@T']);
    // alpha-pod picks worker-2 too: it outranks beta-pod (first name) and governs both teams
    k8s.claims.forEach((c: any) => delete c.metadata.annotations['manythreads.io/move-confirmed']);
    const res = await put(a, 'worker-2');
    expect(res.body.recreatesWorkVolume).toBe(true);
    expect(marks()).toEqual(['hermes-engineering-workspace=worker-2@T', 'hermes-engineering-home=worker-2@T', 'hermes-marketing-workspace=worker-2@T']);
  });

  it('a runner outranked on every team it serves moves nothing and says so truthfully', async () => {
    k8s.claims.length = 0;
    k8s.claims.push(claim(TEAM_IDS.Marketing, 'hermes-marketing-workspace', 'ubuntu-vm'));
    // alpha-pod is at worker-2 (set above) and governs Marketing; beta-pod choosing worker-3 is outranked there (and worker-3 is not Ready: use worker-2's neighbour)
    k8s.nodes.push(node('worker-5'));
    const before = (await events()).length;
    const res = await put(b, 'worker-5');
    expect(res.status).toBe(200);
    expect(res.body.recreatesWorkVolume).toBe(false);
    expect(marks()).toEqual(['hermes-marketing-workspace=-']);
    expect(await events()).toHaveLength(before + 1);
  });

  it('the same machine again, with a move waiting for the admin, confirms it (and says so in an event)', async () => {
    k8s.claims.length = 0;
    k8s.claims.push(claim(TEAM_IDS.Engineering, 'hermes-engineering-workspace', 'ubuntu-vm'));
    const before = (await events()).length;
    const res = await put(a, 'worker-2');
    expect(res.status).toBe(200);
    expect(res.body.recreatesWorkVolume).toBe(true);
    expect(marks()).toEqual(['hermes-engineering-workspace=worker-2@T']);
    expect(await events()).toHaveLength(before + 1);
    // with nothing waiting, the same machine again writes nothing
    k8s.claims.length = 0;
    expect((await put(a, 'worker-2')).status).toBe(200);
    expect(await events()).toHaveLength(before + 1);
  });

  it('a runner that is turned off decides nobody\'s machine, so choosing one for it moves nothing', async () => {
    expect((await w.call<any>(omar, 'PATCH', `/api/admin/bot-runners/${b}`, { enabled: false })).status).toBe(200);
    k8s.claims.length = 0;
    k8s.claims.push(claim(TEAM_IDS.Marketing, 'hermes-marketing-workspace', 'ubuntu-vm'));
    const res = await put(b, 'worker-2');
    expect(res.body.recreatesWorkVolume).toBe(false);
    expect(marks()).toEqual(['hermes-marketing-workspace=-']);
  });

  it('a cluster that does not take the confirmation fails the request and changes nothing', async () => {
    k8s.claims.length = 0;
    k8s.claims.push(claim(TEAM_IDS.Engineering, 'hermes-engineering-workspace', 'ubuntu-vm'));
    const stored = async () => (await w.system(async (tx) => (await tx.query<{ node: string | null }>('SELECT node FROM app.bot_runners WHERE id = $1', [a])).rows[0]))?.node;
    const was = await stored();
    const before = (await events()).length;
    k8s.failNext(1, 'PATCH');
    const res = await put(a, 'worker-2');
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain('forced failure');
    expect(await stored()).toBe(was);
    expect(await events()).toHaveLength(before);
    expect(marks()).toEqual(['hermes-engineering-workspace=-']);
  });
});

describe('migration 0002 on rows written before it (P19-08)', () => {
  it('clears a machine name that is no label value and a machine on a kind that is no pod, so a later edit of that runner does not fail', async () => {
    const sql = readFileSync(new URL('../migrations/0002_runner_node.sql', import.meta.url), 'utf8');
    const pod = (await adminCreate({ name: 'old-pod', label: 'Old pod', kind: 'hermes_pod' })).body.runner.id as string;
    const good = (await adminCreate({ name: 'old-good', label: 'Old good', kind: 'hermes_pod' })).body.runner.id as string;
    const llm = (await adminCreate({ name: 'old-model', label: 'Old model', kind: 'llm_gateway', modelAlias: 'fast' })).body.runner.id as string;
    // the table's owner (the role that runs migrations) sets up the state of a database that has not run 0002 yet, then runs the file
    const owner = new pg.Client({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('ALTER TABLE app.bot_runners DROP CONSTRAINT bot_runners_node_label, DROP CONSTRAINT bot_runners_node_kind');
      await owner.query("UPDATE app.bot_runners SET node = 'has a space' WHERE id = $1::uuid", [pod]);
      await owner.query("UPDATE app.bot_runners SET node = 'ubuntu-vm' WHERE id = $1::uuid", [good]);
      await owner.query("UPDATE app.bot_runners SET node = 'ubuntu-vm' WHERE id = $1::uuid", [llm]);
      await owner.query(sql);
    } finally {
      await owner.end();
    }
    const nodeOf = async (id: string): Promise<string | null | undefined> => (await w.system(async (tx) => (await tx.query<{ node: string | null }>('SELECT node FROM app.bot_runners WHERE id = $1::uuid', [id])).rows[0]))?.node;
    expect(await nodeOf(pod)).toBeNull();
    expect(await nodeOf(llm)).toBeNull();
    expect(await nodeOf(good)).toBe('ubuntu-vm');
    // an unrelated edit of the cleared runners goes through (a NOT VALID check judges the row again on any update)
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${pod}`, { label: 'Old pod 2' })).status).toBe(200);
    expect((await w.call(omar, 'PATCH', `/api/admin/bot-runners/${llm}`, { label: 'Old model 2' })).status).toBe(200);
  });
});
