import { describe, expect, it } from 'vitest';
import { haveHelm, render } from './chart.ts';

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
