import { describe, expect, it } from 'vitest';
import { haveHelm, render, type K8sDoc } from './chart.ts';
import { allows, type Peer, type Pod } from './netpol.ts';

// P19-09 (decision E2): the Claude and Codex pod has a third container, the publisher. The server pod hands its switch and its resources to the controller as two
// environment lines; the pod's one NetworkPolicy has to let that container ask the server (ClusterIP service, server port) and reach git hosts on 443, like the pod.

const REL = 'manythreads';
const BOTS = 'manythreads-bots';
const ON = ['claudePod.enabled=true'];
const serverEnv = (docs: K8sDoc[]): Record<string, string> => {
  const dep = docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'manythreads-server')!;
  const env = dep['spec'].template.spec.containers[0].env as { name: string; value?: string }[];
  return Object.fromEntries(env.filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
};

describe.skipIf(!haveHelm)('the publisher container: environment of the server', () => {
  it('is on by default, with the default resources as JSON', () => {
    for (const set of ['base', 'live']) {
      const env = serverEnv(render(set, [...ON, 'hermesPods.apiServer.cidr=10.0.2.15/32']));
      expect(env['MANYTHREADS_CLAUDE_PODS_PUBLISHER'], set).toBe('1');
      expect(JSON.parse(env['MANYTHREADS_CLAUDE_PODS_PUBLISHER_RESOURCES']!), set).toEqual({ requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } });
    }
  });

  it('claudePod.publisher.enabled=false turns it off with a value the controller reads as off', () => {
    const env = serverEnv(render('live', [...ON, 'claudePod.publisher.enabled=false']));
    expect(env['MANYTHREADS_CLAUDE_PODS_PUBLISHER']).toBe('0');
  });

  it('claudePod.publisher.resources reaches the controller as JSON', () => {
    const env = serverEnv(render('live', [...ON, 'claudePod.publisher.resources.requests.cpu=100m', 'claudePod.publisher.resources.limits.memory=512Mi']));
    expect(JSON.parse(env['MANYTHREADS_CLAUDE_PODS_PUBLISHER_RESOURCES']!)).toEqual({ requests: { cpu: '100m', memory: '64Mi' }, limits: { memory: '512Mi' } });
  });

  it('the controller gets the server address the publisher asks (MANYTHREADS_INCLUSTER_URL) and no line when the Claude pods are off', () => {
    const on = serverEnv(render('live', ON));
    expect(on['MANYTHREADS_INCLUSTER_URL']).toBe('http://manythreads-server.manythreads.svc.cluster.local:3000');
    const off = serverEnv(render('live'));
    expect(off['MANYTHREADS_CLAUDE_PODS_PUBLISHER']).toBeUndefined();
    expect(off['MANYTHREADS_CLAUDE_PODS_PUBLISHER_RESOURCES']).toBeUndefined();
  });
});

describe.skipIf(!haveHelm)('the publisher container: what the pod policy lets it reach', () => {
  const claudePod: Pod = { ns: BOTS, labels: { 'app.kubernetes.io/name': 'manythreads', 'app.kubernetes.io/component': 'claude-pod', 'manythreads.io/team': 'engineering' } };
  const comp = (c: string): Pod => ({ ns: REL, labels: { 'app.kubernetes.io/name': 'manythreads', 'app.kubernetes.io/component': c } });
  const out = (ip: string): Peer => ({ ip });
  const can = (docs: K8sDoc[], to: Peer, port: number): boolean => allows(docs, REL, { pod: claudePod }, to, port);

  it('public443: the server on its port (GET /api/runs/self), git hosts on 443, and nothing else', () => {
    const docs = render('live', ON);
    expect(can(docs, { pod: comp('server') }, 3000)).toBe(true);
    expect(can(docs, { pod: comp('server') }, 22)).toBe(false);
    expect(can(docs, out('140.82.112.3'), 443)).toBe(true); // a public git host
    expect(can(docs, out('140.82.112.3'), 22)).toBe(false); // no ssh
    expect(can(docs, out('140.82.112.3'), 80)).toBe(false);
    expect(can(docs, out('10.1.2.3'), 443)).toBe(false); // private, link-local and CGNAT addresses stay shut
    expect(can(docs, out('169.254.169.254'), 443)).toBe(false);
    expect(can(docs, out('100.64.1.1'), 443)).toBe(false);
    for (const c of ['hindsight', 'litellm', 'web']) expect(can(docs, { pod: comp(c) }, 3000), c).toBe(false);
  });

  it('serverOnly: the server still answers, the git host is out of reach (the publisher can only say refused)', () => {
    const docs = render('live', [...ON, 'claudePod.egress.mode=serverOnly']);
    expect(can(docs, { pod: comp('server') }, 3000)).toBe(true);
    expect(can(docs, out('140.82.112.3'), 443)).toBe(false);
  });

  it('the pod is not given a second policy by the publisher setting: off or on, the same walls', () => {
    const names = (docs: K8sDoc[]): string[] => docs.filter((d) => d.kind === 'NetworkPolicy' && d.metadata.namespace === BOTS).map((d) => d.metadata.name).sort();
    expect(names(render('live', [...ON, 'claudePod.publisher.enabled=false']))).toEqual(names(render('live', ON)));
  });

});
