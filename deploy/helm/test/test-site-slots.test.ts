import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { chartDir, haveHelm, parseDocs, render } from './chart.ts';

// P35-03 (docs/plans/test-site-per-card.md): the live release makes two test-site slots for Engineering. The second has its own host (only that host may
// be served from it) and a smaller quota, so the two slots' ceilings fit beside the live site on a 15 GB node.

describe.skipIf(!haveHelm)('the test-site slots of the live release', () => {
  const docs = render('live');
  const ns = (name: string) => docs.find((d) => d.kind === 'Namespace' && d.metadata.name === name);
  const quota = (name: string) => docs.find((d) => d.kind === 'ResourceQuota' && d.metadata.namespace === name && d.metadata.name === 'deploy-target');

  it('makes both slots, each limited to its own host, with a deployer of its own', () => {
    expect(ns('test-manythreads')?.metadata.annotations?.['manythreads.io/hosts']).toBe('test.manythreads.kahf.to');
    expect(ns('test-card-2')?.metadata.annotations?.['manythreads.io/hosts']).toBe('test2.manythreads.kahf.to');
    for (const n of ['test-manythreads', 'test-card-2']) {
      expect(docs.some((d) => d.kind === 'ServiceAccount' && d.metadata.namespace === n && d.metadata.name === 'deployer'), n).toBe(true);
    }
  });

  it('gives the second slot the smaller quota, and both slots together stay under 16Gi of memory limits', () => {
    expect(quota('test-card-2')?.spec.hard).toMatchObject({ 'requests.memory': '3Gi', 'limits.memory': '7Gi', 'limits.ephemeral-storage': '12Gi' });
    const gi = (v: string) => Number(v.replace(/Gi$/, ''));
    expect(gi(quota('test-manythreads')!.spec.hard['limits.memory']) + gi(quota('test-card-2')!.spec.hard['limits.memory'])).toBeLessThanOrEqual(15);
  });
});

describe.skipIf(!haveHelm)('a card’s test site (deploy/preview/values-card.yaml over values-preview.yaml)', () => {
  const r = spawnSync(
    'helm',
    ['template', 'manythreads', chartDir, '-n', 'test-card-2', '-f', `${chartDir}/../../preview/values-preview.yaml`, '-f', `${chartDir}/../../preview/values-card.yaml`,
      '--set', 'domain=test2.manythreads.kahf.to', '--set', 'server.image=registry.local:5000/test-card-2/server', '--set', 'web.image=registry.local:5000/test-card-2/web', '--set', 'imageTag=abc123'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const docs = r.status === 0 ? parseDocs(r.stdout) : [];
  const mib = (v: string): number => (v.endsWith('Gi') ? Number(v.slice(0, -2)) * 1024 : Number(v.replace(/Mi$/, '')));

  it('renders on the slot’s own host and images, with no network policy and no volume but the database’s 1Gi', () => {
    expect(r.status, r.stderr).toBe(0);
    expect(docs.filter((d) => d.kind === 'NetworkPolicy')).toEqual([]);
    expect(docs.filter((d) => d.kind === 'PersistentVolumeClaim')).toEqual([]);
    expect(docs.find((d) => d.kind === 'Cluster')?.spec.storage.size).toBe('1Gi');
    expect(JSON.stringify(docs.filter((d) => d.kind === 'Ingress'))).toContain('test2.manythreads.kahf.to');
    expect(JSON.stringify(docs.filter((d) => d.kind === 'Deployment'))).toContain('registry.local:5000/test-card-2/server:abc123');
  });

  it('caps every container, and the running site fits in the slot beside one build (under 3Gi at the limits)', () => {
    type C = { name: string; resources?: { limits?: { memory?: string } } };
    const of = (d: (typeof docs)[number]): C[] => (d.spec?.template?.spec?.containers ?? []) as C[];
    for (const c of docs.flatMap(of)) expect(c.resources?.limits?.memory, c.name).toBeDefined();
    // what stays running beside a rebuild (the seed Job runs once, at install, before any rebuild): server, web, mail catcher and the database
    const containers = docs.filter((d) => d.kind !== 'Job').flatMap(of);
    expect(containers.length).toBeGreaterThan(2);
    const cluster = docs.find((d) => d.kind === 'Cluster')?.spec.resources.limits.memory as string;
    const total = containers.reduce((n, c) => n + mib(c.resources!.limits!.memory!), 0) + mib(cluster);
    expect(total).toBeLessThan(3 * 1024);
  });
});
