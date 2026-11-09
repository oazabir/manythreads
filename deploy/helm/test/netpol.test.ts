import { describe, expect, it } from 'vitest';
import { haveHelm, render } from './chart.ts';
import { allows, type Peer, type Pod } from './netpol.ts';

// P10-08 acceptance: a pod-to-pod matrix over the rendered release policies. The evaluator (netpol.ts) says, with the rules of the NetworkPolicy API, who may call whom.
// The lists "must still work" are the paths the platform needs (the plan's CR-2 list): the CNPG operator, the backup and restore tools, the seed Job,
// Hindsight to the database and to the gateway, the server to LiteLLM and Hindsight, and the Hermes and Claude pods to the server's MCP.

const REL = 'manythreads';
const BOTS = 'manythreads-bots';
const BASE_SET = ['hermesPods.apiServer.cidr=10.0.2.15/32'];
const comp = (c: string, ns = REL, extra: Record<string, string> = {}): Pod => ({ ns, labels: { 'app.kubernetes.io/name': 'manythreads', 'app.kubernetes.io/component': c, ...extra } });
const pod = (p: Pod): Peer => ({ pod: p });

const server = comp('server');
const web = comp('web');
const seed = comp('seed');
const backup = comp('backup');
const backupTool = comp('backup-tool');
const hindsight = comp('hindsight');
const litellm = comp('litellm');
const mailpit = comp('mailpit');
const media = comp('media');
const hermesPod = comp('hermes-pod', BOTS, { 'manythreads.io/team': 'engineering' });
const claudePod = comp('claude-pod', BOTS, { 'manythreads.io/team': 'engineering' });
const dbPod = (n: number): Pod => ({ ns: REL, labels: { 'cnpg.io/cluster': 'manythreads-pg', 'cnpg.io/podRole': 'instance', role: n === 1 ? 'primary' : 'replica' } });
const operator: Pod = { ns: 'cnpg-system', labels: { 'app.kubernetes.io/name': 'cloudnative-pg' } };
const stranger: Pod = { ns: REL, labels: { run: 'something-else' } };
const appPod: Pod = { ns: 'apps-engineering', labels: { app: 'a-deployed-app' } };
const testPod: Pod = { ns: 'test-manythreads', labels: { app: 'preview' } };
const traefik: Pod = { ns: 'kube-system', labels: { 'app.kubernetes.io/name': 'traefik' } };

describe.skipIf(!haveHelm)('the release policies (live values)', () => {
  const policies = render('live');
  const ok = (from: Pod, to: Pod, port: number): boolean => allows(policies, REL, pod(from), pod(to), port);

  it('Hindsight answers the server and nobody else', () => {
    expect(ok(server, hindsight, 8888)).toBe(true);
    for (const who of [web, seed, backup, backupTool, litellm, mailpit, media, hermesPod, claudePod, stranger, appPod, testPod, operator, traefik, dbPod(1)]) expect(ok(who, hindsight, 8888), JSON.stringify(who.labels)).toBe(false);
    expect(ok(server, hindsight, 5432)).toBe(false); // only its own port
  });

  it('LiteLLM answers the server, Hindsight and the pods namespace, and nobody else', () => {
    for (const who of [server, hindsight, hermesPod, claudePod]) expect(ok(who, litellm, 4000), JSON.stringify(who.labels)).toBe(true);
    for (const who of [web, seed, backup, backupTool, mailpit, media, stranger, appPod, testPod, operator, traefik, dbPod(1)]) expect(ok(who, litellm, 4000), JSON.stringify(who.labels)).toBe(false);
    expect(ok(server, litellm, 22)).toBe(false);
  });

  it('the database answers its clients, its operator and its peers, and nobody else', () => {
    // the server, the seed Job, the backup CronJob, the restore tool's pods, Hindsight and LiteLLM (their init containers and their engines)
    for (const who of [server, seed, backup, backupTool, hindsight, litellm]) expect(ok(who, dbPod(1), 5432), JSON.stringify(who.labels)).toBe(true);
    // the operator talks to the instance manager's status port and the database port; the standby follows the primary
    for (const port of [5432, 8000, 9187]) expect(ok(operator, dbPod(1), port), String(port)).toBe(true);
    for (const port of [5432, 8000]) expect(ok(dbPod(2), dbPod(1), port), String(port)).toBe(true);
    for (const who of [web, mailpit, media, hermesPod, claudePod, stranger, appPod, testPod, traefik]) expect(ok(who, dbPod(1), 5432), JSON.stringify(who.labels)).toBe(false);
    expect(ok(server, dbPod(1), 8000)).toBe(false); // the status port is the operator's
    expect(ok(server, dbPod(1), 22)).toBe(false);
  });

  it('what must keep working still works: the server, the web pod and the bots', () => {
    expect(ok(web, server, 3000)).toBe(true);
    expect(ok(hermesPod, server, 3000)).toBe(true); // the bots' tools (MCP)
    expect(ok(claudePod, server, 3000)).toBe(true);
    expect(ok(server, hermesPod, 8642)).toBe(true); // the pod's gateway
    expect(ok(server, claudePod, 8650)).toBe(true);
    expect(ok(traefik, web, 80)).toBe(true);
    expect(ok(server, mailpit, 1025)).toBe(true);
  });

  it('the server answers everyone while its own policy is off (the default)', () => {
    for (const who of [web, hermesPod, claudePod, stranger, traefik, media]) expect(ok(who, server, 3000), JSON.stringify(who.labels)).toBe(true);
    // the apps and the preview namespaces are shut by their own default-deny egress (templates/hermes-pods.yaml, deploy-targets.yaml), whatever the release says
    for (const who of [appPod, testPod]) expect(ok(who, server, 3000), JSON.stringify(who.labels)).toBe(false);
  });
});

describe.skipIf(!haveHelm)('the release policies in a default install', () => {
  const policies = render('base', BASE_SET);
  it('are the same walls, for the same pods', () => {
    const ok = (from: Pod, to: Pod, port: number): boolean => allows(policies, REL, pod(from), pod(to), port);
    expect(ok(server, hindsight, 8888)).toBe(true);
    expect(ok(stranger, hindsight, 8888)).toBe(false);
    expect(ok(hermesPod, litellm, 4000)).toBe(true);
    expect(ok(appPod, litellm, 4000)).toBe(false);
    expect(ok(operator, dbPod(1), 8000)).toBe(true);
    expect(ok(stranger, dbPod(1), 5432)).toBe(false);
  });
});

describe.skipIf(!haveHelm)('the release policies in the test namespaces', () => {
  it('ci and stage: the database policy lets the seed Job, the server and the operator in; there is none for what is not there', () => {
    for (const set of ['ci', 'stage']) {
      const policies = render(set);
      const ok = (from: Pod, to: Pod, port: number): boolean => allows(policies, REL, pod(from), pod(to), port);
      expect(ok(seed, dbPod(1), 5432), set).toBe(true);
      expect(ok(server, dbPod(1), 5432), set).toBe(true);
      expect(ok(operator, dbPod(1), 8000), set).toBe(true);
      expect(ok(stranger, dbPod(1), 5432), set).toBe(false);
      expect(policies.filter((p) => p.kind === 'NetworkPolicy').map((p) => p.metadata.name), set).toEqual(['manythreads-postgres']);
    }
  });
});

describe.skipIf(!haveHelm)('the switches', () => {
  it('networkPolicies.release.enabled=false renders none of the release policies', () => {
    const docs = render('live', ['networkPolicies.release.enabled=false']);
    expect(docs.filter((d) => d.kind === 'NetworkPolicy' && (d.metadata.namespace ?? REL) === REL)).toEqual([]);
    // the pods namespace keeps its own
    expect(docs.some((d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'manythreads-hermes-pods')).toBe(true);
  });

  it('the operator namespace is a value', () => {
    const policies = render('live', ['networkPolicies.release.operatorNamespace=databases']);
    const other: Pod = { ns: 'databases', labels: {} };
    expect(allows(policies, REL, pod(other), pod(dbPod(1)), 8000)).toBe(true);
    expect(allows(policies, REL, pod(operator), pod(dbPod(1)), 8000)).toBe(false);
  });

  it('the server policy, when turned on, lets in the web pod, the jobs, the bots and the ingress controller, and shuts out other namespaces', () => {
    const policies = render('live', ['networkPolicies.release.server.enabled=true', 'networkPolicies.release.server.extraCidrs={10.0.2.15/32}']);
    const ok = (from: Peer, to: Pod, port: number): boolean => allows(policies, REL, from, pod(to), port);
    for (const who of [web, seed, backup, media, hermesPod, claudePod, traefik]) expect(ok(pod(who), server, 3000), JSON.stringify(who.labels)).toBe(true);
    expect(ok({ ip: '10.0.2.15' }, server, 3000)).toBe(true); // a pod on the host network, a tool on the host
    for (const who of [appPod, testPod, operator]) expect(ok(pod(who), server, 3000), JSON.stringify(who.labels)).toBe(false);
    expect(ok({ ip: '203.0.113.9' }, server, 3000)).toBe(false);
    expect(ok(pod(web), server, 22)).toBe(true); // same-namespace pods are let in on any port: the walls here are about other namespaces
  });
});
