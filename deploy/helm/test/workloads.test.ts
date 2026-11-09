import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKLOAD_KINDS, haveHelm, idOf, render } from './chart.ts';

// P10-07 acceptance: the default install is five workloads; the ci, stage and live values render the same workloads as before the defaults changed.
// workloads-before.json is the list made BEFORE the change (commit f4ae8b0b): every object `helm template` rendered for each set of values.

const here = dirname(fileURLToPath(import.meta.url));
const before = JSON.parse(readFileSync(join(here, 'workloads-before.json'), 'utf8')) as Record<'base' | 'ci' | 'stage' | 'live', string[]>;
const kindOf = (id: string): string => id.split('/')[0]!;
const workloadsOf = (ids: string[]): string[] => ids.filter((id) => WORKLOAD_KINDS.has(kindOf(id))).sort();
// `helm template` cannot look the Kubernetes API address up (no cluster), and the Hermes pod controller's policy needs it: the base values are rendered with it set.
const BASE_SET = ['hermesPods.apiServer.cidr=10.0.2.15/32'];

describe.skipIf(!haveHelm)('the workloads the chart renders', () => {
  it('base values: the database, server, web, LiteLLM and Hindsight, and the Hermes pod controller (its pods are made per team, later)', () => {
    const docs = render('base', BASE_SET);
    const ids = docs.map(idOf);
    expect(workloadsOf(ids)).toEqual(['Cluster/-/manythreads-pg', 'Deployment/-/manythreads-hindsight', 'Deployment/-/manythreads-litellm', 'Deployment/-/manythreads-server', 'Deployment/-/manythreads-web', 'Job/-/manythreads-seed'].sort());
    // the controller of the Hermes pods: its account, its Role in the pods namespace and the walls around the pods
    expect(ids).toContain('ServiceAccount/-/manythreads-server');
    expect(ids).toContain('Role/manythreads-bots/manythreads-hermes-pods-controller');
    expect(ids).toContain('NetworkPolicy/manythreads-bots/manythreads-hermes-pods');
    // off by default: the mail catcher, voice, speech to text, the registry, backups, the Claude pods and every stand-in
    for (const off of ['mailpit', 'media', 'asr', 'registry', 'backup', 'claude', 'fake']) expect(ids.filter((i) => i.toLowerCase().includes(off)), off).toEqual([]);
    // the platform adds no kind of its own to the cluster
    expect(ids.filter((i) => kindOf(i) === 'CustomResourceDefinition')).toEqual([]);
  });

  it.each(['ci', 'stage', 'live'] as const)('%s values: the same workloads as before the defaults changed', (set) => {
    const docs = render(set);
    expect(workloadsOf(docs.map(idOf))).toEqual(workloadsOf(before[set]));
  });

  it('ci and stage values: nothing else changed but the database policy', () => {
    for (const set of ['ci', 'stage'] as const) {
      const now = render(set).map(idOf).sort();
      const added = now.filter((i) => !before[set].includes(i));
      expect(added, set).toEqual(['NetworkPolicy/-/manythreads-postgres']);
      expect(before[set].filter((i) => !now.includes(i)), set).toEqual([]);
    }
  });

  it('live values: nothing is removed; the new objects are the release policies, the hindsight Database and the split-off internet policy', () => {
    const now = render('live').map(idOf).sort();
    expect(before.live.filter((i) => !now.includes(i))).toEqual([]);
    expect(now.filter((i) => !before.live.includes(i))).toEqual([
      'Database/-/manythreads-pg-hindsight',
      'NetworkPolicy/-/manythreads-hindsight',
      'NetworkPolicy/-/manythreads-litellm',
      'NetworkPolicy/-/manythreads-postgres',
      'NetworkPolicy/manythreads-bots/manythreads-hermes-pods-internet',
    ]);
  });

  it('live values pin every toggle the base values changed', () => {
    const docs = render('live');
    const ids = docs.map(idOf);
    for (const on of ['Deployment/-/manythreads-mailpit', 'Deployment/-/manythreads-litellm', 'Deployment/-/manythreads-hindsight']) expect(ids).toContain(on);
  });
});
