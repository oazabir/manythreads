import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chartDir, haveHelm, idOf, parseDocs, render, type K8sDoc } from './chart.ts';

// P38-05a: a SECOND release (the install profile plus values-second-install.yaml) in a leased namespace of the same cluster as the live release.
// The two must not share a cluster-wide name or a namespace, and the live render must not move a single object. docs/deploy.md, "A second release on the same cluster".

const here = dirname(fileURLToPath(import.meta.url));
const SECOND_NS = 'test-manythreads';
const SECOND_SET = ['domain=test.example.org', 'hermesPods.apiServer.cidr=10.0.2.15/32', 'tls.letsencrypt.email=ops@example.org'];

/** `helm template` of the second release: release `manythreads` in the leased namespace, install profile first, the second-install file second. */
function renderSecond(sets: string[] = SECOND_SET, files: string[] = ['values-install.yaml', 'values-second-install.yaml']): { code: number; err: string; docs: K8sDoc[] } {
  const args = ['template', 'manythreads', chartDir, '-n', SECOND_NS, ...files.flatMap((f) => ['-f', join(chartDir, f)]), ...sets.flatMap((s) => ['--set', s])];
  const r = spawnSync('helm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, err: r.stderr, docs: r.status === 0 ? parseDocs(r.stdout) : [] };
}

// Kinds that belong to no namespace. A kind the chart starts to render that is in neither list stops the test: decide first whether it is cluster-wide.
const CLUSTER_KINDS = new Set(['Namespace', 'ClusterRole', 'ClusterRoleBinding', 'ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding']);
const NAMESPACED_KINDS = new Set([
  'Certificate', 'Cluster', 'ConfigMap', 'CronJob', 'Database', 'Deployment', 'Ingress', 'Issuer', 'Job', 'LimitRange', 'Middleware', 'NetworkPolicy',
  'ObjectStore', 'PersistentVolumeClaim', 'ResourceQuota', 'Role', 'RoleBinding', 'ScheduledBackup', 'Secret', 'Service', 'ServiceAccount', 'StatefulSet', 'TLSStore',
]);

const byKind = (docs: K8sDoc[], kind: string): K8sDoc[] => docs.filter((d) => d.kind === kind);
/** The apps admission policy (the live release has a second one, for its deploy targets, that this release never makes). */
const appsPolicy = (docs: K8sDoc[], kind: 'ValidatingAdmissionPolicy' | 'ValidatingAdmissionPolicyBinding'): K8sDoc => byKind(docs, kind).find((d) => d.metadata.name.startsWith('manythreads-apps-guard'))!;
const clusterIds = (docs: K8sDoc[]): string[] => docs.filter((d) => CLUSTER_KINDS.has(d.kind)).map((d) => `${d.kind}/${d.metadata.name}`).sort();
const isLiveNamespace = (ns: string): boolean => ns === 'manythreads' || ns === 'manythreads-bots' || ns.startsWith('apps-');
/** Memory in Mi, storage in Gi: the only units the chart's values use. */
const toMi = (q: string): number => (q.endsWith('Gi') ? parseInt(q, 10) * 1024 : q.endsWith('Mi') ? parseInt(q, 10) : NaN);
const podSpecs = (docs: K8sDoc[]): { name: string; containers: { resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }[] }[] =>
  docs.flatMap((d) => {
    if (d.kind === 'Deployment' || d.kind === 'StatefulSet') return [{ name: d.metadata.name, containers: d['spec'].template.spec.containers }];
    if (d.kind === 'CronJob') return [{ name: d.metadata.name, containers: d['spec'].jobTemplate.spec.template.spec.containers }];
    if (d.kind === 'Cluster') return [{ name: d.metadata.name, containers: [{ resources: d['spec'].resources }] }];
    return [];
  });

describe.skipIf(!haveHelm)('a second release on the same cluster', () => {
  const live = render('live');
  const second = renderSecond();

  it('renders', () => {
    expect(second.err).toBe('');
    expect(second.code).toBe(0);
    // the install profile: its own database, LiteLLM, Hindsight, the managed Hermes pods, backups; no demo seed, no voice
    const ids = second.docs.map(idOf);
    for (const on of ['Cluster/-/manythreads-pg', 'Deployment/-/manythreads-server', 'Deployment/-/manythreads-litellm', 'Deployment/-/manythreads-hindsight', 'CronJob/-/manythreads-backup']) expect(ids, on).toContain(on);
    for (const off of ['seed', 'mailpit', 'registry', 'media', 'asr']) expect(ids.filter((i) => i.toLowerCase().includes(off)), off).toEqual([]);
  });

  it('knows every kind it renders (a new kind must be placed as cluster-wide or not)', () => {
    for (const d of [...live, ...second.docs]) expect(CLUSTER_KINDS.has(d.kind) || NAMESPACED_KINDS.has(d.kind), d.kind).toBe(true);
  });

  it('shares no cluster-wide name with the live release', () => {
    const liveIds = clusterIds(live);
    const secondIds = clusterIds(second.docs);
    expect(secondIds.filter((i) => liveIds.includes(i))).toEqual([]);
    // what a second release does make cluster-wide: its two namespaces (pods, one team's apps), the nodes reader, the apps admission policy and its binding
    expect(secondIds).toEqual([
      'ClusterRole/test-manythreads-manythreads-nodes-reader',
      'ClusterRoleBinding/test-manythreads-manythreads-nodes-reader',
      'Namespace/test-apps-engineering',
      'Namespace/test-bots',
      'ValidatingAdmissionPolicy/manythreads-apps-guard-second',
      'ValidatingAdmissionPolicyBinding/manythreads-apps-guard-second',
    ]);
    // the binding names its own policy, never the live one
    expect(appsPolicy(second.docs, 'ValidatingAdmissionPolicyBinding')['spec'].policyName).toBe('manythreads-apps-guard-second');
    expect(appsPolicy(live, 'ValidatingAdmissionPolicyBinding')['spec'].policyName).toBe('manythreads-apps-guard');
  });

  it('puts nothing in a namespace of the live release, and never makes or adopts the leased namespace itself', () => {
    for (const d of second.docs) {
      if (d.kind !== 'Namespace' && d.metadata.namespace) expect(isLiveNamespace(d.metadata.namespace), idOf(d)).toBe(false);
      if (d.kind === 'Namespace') {
        expect(isLiveNamespace(d.metadata.name), idOf(d)).toBe(false);
        expect(d.metadata.name, 'the release namespace is the lease: the chart does not make it').not.toBe(SECOND_NS);
      }
      // everything with a namespace of its own is in the pods namespace or in an apps namespace of the second release
      if (d.metadata.namespace) expect(d.metadata.namespace === 'test-bots' || d.metadata.namespace.startsWith('test-apps-'), idOf(d)).toBe(true);
    }
    // a namespace it makes is left behind on uninstall (the teams' volumes live there), as in the first release
    for (const n of byKind(second.docs, 'Namespace')) expect(n.metadata.annotations?.['helm.sh/resource-policy'], n.metadata.name).toBe('keep');
  });

  it('every name the server is told follows the values', () => {
    const dep = second.docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'manythreads-server')!;
    const env = Object.fromEntries((dep['spec'].template.spec.containers[0].env as { name: string; value?: string }[]).filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
    expect(env['MANYTHREADS_HERMES_PODS_NAMESPACE']).toBe('test-bots');
    expect(env['MANYTHREADS_HERMES_PODS_APPS_PREFIX']).toBe('test-apps-');
    expect(env['MANYTHREADS_INCLUSTER_URL']).toBe(`http://manythreads-server.${SECOND_NS}.svc.cluster.local:3000`);
    expect(env['MANYTHREADS_INCLUSTER_LLM_URL']).toBe(`http://manythreads-litellm.${SECOND_NS}.svc.cluster.local:4000/v1`);
    // the controller's rights and the pods' walls are in the second namespaces, and the walls name the second release's namespace
    expect(second.docs.map(idOf)).toContain('Role/test-bots/manythreads-hermes-pods-controller');
    const wall = second.docs.find((d) => d.kind === 'NetworkPolicy' && d.metadata.name === 'manythreads-hermes-pods')!;
    expect(JSON.stringify(wall['spec'].ingress)).toContain(SECOND_NS);
    expect(JSON.stringify(wall['spec'])).not.toContain('"manythreads"');
  });

  it('each release\'s admission policy judges only its own apps namespaces', () => {
    const mark = (d: K8sDoc): string => d['spec'].matchConstraints.namespaceSelector.matchLabels['manythreads.io/apps'];
    const liveMark = mark(appsPolicy(live, 'ValidatingAdmissionPolicy'));
    const secondMark = mark(appsPolicy(second.docs, 'ValidatingAdmissionPolicy'));
    expect(liveMark).toBe('true');
    expect(secondMark).not.toBe(liveMark);
    const appsNamespaces = (docs: K8sDoc[], prefix: string) => byKind(docs, 'Namespace').filter((n) => n.metadata.name.startsWith(prefix));
    expect(appsNamespaces(live, 'apps-').length).toBeGreaterThan(0);
    for (const n of appsNamespaces(live, 'apps-')) expect(n.metadata.labels!['manythreads.io/apps'], n.metadata.name).toBe(liveMark);
    expect(appsNamespaces(second.docs, 'test-apps-').map((n) => n.metadata.name)).toEqual(['test-apps-engineering']);
    for (const n of appsNamespaces(second.docs, 'test-apps-')) expect(n.metadata.labels!['manythreads.io/apps'], n.metadata.name).toBe(secondMark);
    // the second policy checks hosts against the second site's domain (path routing: the platform's own host)
    expect(JSON.stringify(appsPolicy(second.docs, 'ValidatingAdmissionPolicy')['spec'].variables)).toContain('test.example.org');
  });

  it('opens the leased namespace\'s walls for the pods, and only for them, and not at all in the live release', () => {
    const names = (docs: K8sDoc[]) => byKind(docs, 'NetworkPolicy').map((n) => n.metadata.name);
    expect(names(second.docs)).toEqual(expect.arrayContaining(['manythreads-server-to-pods', 'manythreads-server-from-pods']));
    expect(names(live)).not.toContain('manythreads-server-to-pods');
    const to = second.docs.find((d) => d.metadata.name === 'manythreads-server-to-pods')!;
    expect(to['spec'].policyTypes).toEqual(['Egress']);
    expect(JSON.stringify(to['spec'].egress)).toContain('test-bots');
    expect(JSON.stringify(to['spec'].egress)).toContain('10.0.2.15/32');
    const from = second.docs.find((d) => d.metadata.name === 'manythreads-server-from-pods')!;
    expect(from['spec'].policyTypes).toEqual(['Ingress']);
    expect(JSON.stringify(from['spec'].ingress)).toContain('test-bots');
  });

  it('serves HTTPS with Let\'s Encrypt for the one host and leaves the cluster\'s default certificate to the first release', () => {
    expect(byKind(second.docs, 'TLSStore')).toEqual([]);
    const cert = byKind(second.docs, 'Certificate')[0]!;
    expect(cert['spec'].dnsNames).toEqual(['test.example.org']);
    // what a leased namespace's admission rule allows: an Issuer of its own namespace, ACME, plain HTTP-01
    const issuer = byKind(second.docs, 'Issuer')[0]!;
    expect(issuer['spec'].acme.solvers.every((s: { http01?: { ingress?: { ingressTemplate?: unknown } } }) => s.http01 && !s.http01.ingress?.ingressTemplate)).toBe(true);
    // an Ingress there needs a host from the namespace's list, no traefik.* annotation, no default backend
    for (const i of byKind(second.docs, 'Ingress')) {
      expect(Object.keys(i.metadata.annotations ?? {}).filter((k) => k.startsWith('traefik.')), i.metadata.name).toEqual([]);
      expect(i['spec'].defaultBackend).toBeUndefined();
      expect((i['spec'].rules as { host: string }[]).map((r) => r.host)).toEqual(['test.example.org']);
    }
  });

  it('fits the leased namespace\'s quota (what the live release gives a deploy target by default)', () => {
    const quota = byKind(live, 'ResourceQuota').find((q) => q.metadata.namespace === SECOND_NS && q.metadata.name === 'deploy-target')!['spec'].hard as Record<string, string>;
    const specs = podSpecs(second.docs);
    const sum = (key: 'requests' | 'limits', res: string): number => specs.reduce((a, p) => a + p.containers.reduce((b, c) => b + toMi(c.resources?.[key]?.[res] ?? '0Mi'), 0), 0);
    // every container states its memory (an unstated one is given the namespace's default of 512Mi: it must be a choice)
    for (const p of specs) for (const c of p.containers) expect(c.resources?.limits?.['memory'], p.name).toBeTruthy();
    expect(sum('requests', 'memory')).toBeLessThanOrEqual(toMi(quota['requests.memory']!));
    expect(sum('limits', 'memory')).toBeLessThanOrEqual(toMi(quota['limits.memory']!));
    const pvcs = byKind(second.docs, 'PersistentVolumeClaim').map((p) => toMi(p['spec'].resources.requests.storage as string));
    const pgInstances = byKind(second.docs, 'Cluster').reduce((a, c) => a + (c['spec'].instances as number), 0);
    const pgStorage = byKind(second.docs, 'Cluster').reduce((a, c) => a + toMi(c['spec'].storage.size as string) * (c['spec'].instances as number), 0);
    expect(pvcs.length + pgInstances).toBeLessThanOrEqual(parseInt(quota['persistentvolumeclaims']!, 10));
    expect(pvcs.reduce((a, b) => a + b, 0) + pgStorage).toBeLessThanOrEqual(toMi(quota['requests.storage']!));
  });

  it('the profile the coordinator was given: memory sizes of the second-install file', () => {
    const req = (name: string) => podSpecs(second.docs).find((p) => p.name === name)!.containers[0]!.resources;
    expect(req('manythreads-litellm')).toMatchObject({ requests: { memory: '768Mi' }, limits: { memory: '1Gi' } });
    expect(req('manythreads-hindsight')).toMatchObject({ requests: { memory: '1Gi' }, limits: { memory: '2Gi' } });
    expect(req('manythreads-server')).toMatchObject({ requests: { memory: '512Mi' }, limits: { memory: '1Gi' } });
    expect(req('manythreads-pg')).toMatchObject({ requests: { memory: '256Mi' }, limits: { memory: '1Gi' } });
    // the file carries no domain and no Kubernetes API address: they are given with --set
    const file = readFileSync(join(chartDir, 'values-second-install.yaml'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(file).not.toMatch(/^\s*domain:/m);
    expect(file).not.toMatch(/^\s*cidr:/m);
    expect(file).not.toMatch(/password|secret|token|apiKey|email/i);
  });

  it('refuses a render that would collide', () => {
    // without the second-install file the names are the first release's: the same render, the same cluster-wide names
    const plain = renderSecond(SECOND_SET, ['values-install.yaml']);
    const overlap = clusterIds(plain.docs).filter((i) => clusterIds(live).includes(i));
    expect(overlap).toEqual(expect.arrayContaining(['Namespace/manythreads-bots', 'ValidatingAdmissionPolicy/manythreads-apps-guard', 'ValidatingAdmissionPolicyBinding/manythreads-apps-guard']))
    // a suffix with the first release's namespace names would still collide
    const noNames = renderSecond([...SECOND_SET, 'clusterScopedSuffix=second'], ['values-install.yaml']);
    expect(noNames.code).not.toBe(0);
    expect(noNames.err).toContain('hermesPods.namespace');
    for (const bad of ['clusterScopedSuffix=true', 'clusterScopedSuffix=Second', 'clusterScopedSuffix=a_b', 'clusterScopedSuffix=-x']) {
      const r = renderSecond([...SECOND_SET, bad]);
      expect(r.code, bad).not.toBe(0);
      expect(r.err, bad).toContain('clusterScopedSuffix');
    }
    // a second release makes no deploy targets (their admission rules are cluster-wide)
    const r = renderSecond([...SECOND_SET, 'hermesPods.deployTargets[0].namespace=t-x', 'hermesPods.deployTargets[0].team=engineering', 'hermesPods.deployTargets[0].hosts[0]=x.example.org']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('second release');
  });

  it('leaves the live render as it was: same kinds, same names', () => {
    const before = JSON.parse(readFileSync(join(here, 'second-release.live.json'), 'utf8')) as string[];
    expect(live.map(idOf).sort()).toEqual(before);
    // and the two cluster-wide names and the label the live site has run with since the apps policy first shipped
    expect(live.map(idOf)).toEqual(expect.arrayContaining(['ValidatingAdmissionPolicy/-/manythreads-apps-guard', 'ValidatingAdmissionPolicyBinding/-/manythreads-apps-guard', 'ClusterRole/-/manythreads-manythreads-nodes-reader']));
    for (const n of byKind(live, 'Namespace').filter((x) => x.metadata.labels?.['manythreads.io/team'] && x.metadata.name.startsWith('apps-'))) expect(n.metadata.labels!['manythreads.io/apps']).toBe('true');
  });
});
