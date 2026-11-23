import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { K8s, K8sObject } from '@manythreads/sdk/pods';
import { describe, expect, it } from 'vitest';
import { teardownPass, teardownSite, type Cluster } from '../src/teardown.ts';

// P35-03: the server removes a card's test site with the slot's own login. What a site is made of goes; the slot's login, its kept secrets and anything
// outside the release stay; a refusal leaves the slot to the next pass. The cluster is an in-memory double of the client the server uses.

type Obj = { kind: string; ns: string; name: string; labels: Record<string, string> };
const INSTANCE = { 'app.kubernetes.io/instance': 'manythreads' };

function cluster(objects: Obj[], refuse: string | null = null): K8s & { objects: Obj[]; deleted: string[] } {
  const deleted: string[] = [];
  const matches = (o: Obj, selector: string) => selector === '' || selector.split(',').every((p) => o.labels[p.split('=')[0]!] === p.split('=')[1]);
  return {
    objects,
    deleted,
    apply: async () => undefined,
    get: async (kind, ns, name) => {
      const o = objects.find((x) => x.kind === kind && x.ns === ns && x.name === name);
      return o ? ({ apiVersion: 'v1', kind, metadata: { name, namespace: ns }, data: { token: Buffer.from('slot-token').toString('base64') } } as K8sObject) : null;
    },
    list: async (kind, ns, selector) => objects.filter((o) => o.kind === kind && o.ns === ns && matches(o, selector)).map((o) => ({ apiVersion: 'v1', kind, metadata: { name: o.name, namespace: ns } }) as K8sObject),
    delete: async (kind, ns, name) => {
      if (refuse === `${kind}/${name}`) throw new Error(`delete ${kind}/${name}: 403 forbidden`);
      deleted.push(`${kind}/${ns}/${name}`);
      const i = objects.findIndex((o) => o.kind === kind && o.ns === ns && o.name === name);
      if (i >= 0) objects.splice(i, 1);
    },
  };
}

const site = (ns: string): Obj[] => [
  { kind: 'Cluster', ns, name: 'manythreads-pg', labels: INSTANCE },
  { kind: 'Deployment', ns, name: 'manythreads-server', labels: INSTANCE },
  { kind: 'Deployment', ns, name: 'manythreads-web', labels: INSTANCE },
  { kind: 'Ingress', ns, name: 'manythreads', labels: INSTANCE },
  { kind: 'Certificate', ns, name: 'manythreads-tls', labels: INSTANCE },
  { kind: 'Service', ns, name: 'manythreads-server', labels: INSTANCE },
  { kind: 'ConfigMap', ns, name: 'manythreads-config', labels: INSTANCE },
  { kind: 'ConfigMap', ns, name: 'patches-abc123', labels: {} },
  { kind: 'ConfigMap', ns, name: 'kube-root-ca.crt', labels: {} },
  { kind: 'Job', ns, name: 'build-abc123', labels: {} },
  { kind: 'Job', ns, name: 'manythreads-seed', labels: INSTANCE },
  { kind: 'Secret', ns, name: 'sh.helm.release.v1.manythreads.v3', labels: { owner: 'helm', name: 'manythreads' } },
  { kind: 'Secret', ns, name: 'manythreads-db-owner', labels: INSTANCE },
  { kind: 'Secret', ns, name: 'manythreads-server-secrets', labels: INSTANCE },
  { kind: 'Secret', ns, name: 'deployer-token', labels: {} },
  { kind: 'PersistentVolumeClaim', ns, name: 'manythreads-pg-1', labels: { 'cnpg.io/cluster': 'manythreads-pg' } },
];

describe('removing a test site', () => {
  it('deletes the release, its builds, its patch series, Helm’s record and its volumes; keeps the slot’s login, the kept secrets and the cluster’s own objects', async () => {
    const k = cluster([...site('test-card-2'), ...site('other-ns')]);
    const n = await teardownSite(k, 'test-card-2');
    expect(n).toBe(13);
    expect(k.objects.filter((o) => o.ns === 'test-card-2').map((o) => `${o.kind}/${o.name}`).sort()).toEqual([
      'ConfigMap/kube-root-ca.crt',
      'Secret/deployer-token',
      'Secret/manythreads-server-secrets',
    ]);
    // the database goes first, and nothing of another namespace is touched
    expect(k.deleted[0]).toBe('Cluster/test-card-2/manythreads-pg');
    expect(k.deleted.every((d) => d.includes('/test-card-2/'))).toBe(true);
    expect(k.objects.filter((o) => o.ns === 'other-ns')).toHaveLength(site('other-ns').length);
  });

  it('stops at a refusal (the pass tries again)', async () => {
    const k = cluster(site('test-card-2'), 'Ingress/manythreads');
    await expect(teardownSite(k, 'test-card-2')).rejects.toThrow('403');
  });
});

describe('a teardown pass', () => {
  function harness(due: { o_namespace: string; o_task_id: string | null; o_reason: string }[]) {
    const sql: string[] = [];
    const lines: string[] = [];
    const tx = {
      actor: { id: 'system', kind: 'system', workspaceId: 'w' },
      query: async (text: string) => {
        sql.push(text);
        if (text.includes('tasks_release_test_sites')) return { rows: due };
        return { rows: [] };
      },
    } as unknown as PluginTx;
    const ctx = { db: { system: (fn: (t: PluginTx) => unknown) => fn(tx) }, audit: { emit: async () => undefined } } as unknown as PluginContext;
    return { ctx, sql, lines, log: (l: string) => void lines.push(l) };
  }

  it('removes each due site with the slot’s own login and frees the slot; a failure leaves it for the next minute', async () => {
    const h = harness([
      { o_namespace: 'test-card-2', o_task_id: null, o_reason: 'the card is done' },
      { o_namespace: 'test-manythreads', o_task_id: null, o_reason: 'no deploy for a day' },
    ]);
    const k = cluster([...site('test-card-2'), ...site('test-manythreads')], 'Ingress/manythreads');
    // the first slot's teardown succeeds; then the double refuses the second slot's Ingress
    let slots = 0;
    const tokens: string[] = [];
    const c: Cluster = {
      server: k,
      asSlot: (token) => {
        tokens.push(token);
        slots++;
        return slots === 1 ? cluster(site('test-card-2')) : k;
      },
    };
    const r = await teardownPass(h.ctx, c, h.log);
    expect(r).toEqual({ freed: ['test-card-2'], failed: ['test-manythreads'] });
    expect(tokens).toEqual(['slot-token', 'slot-token']);
    expect(h.sql.filter((s) => s.includes('tasks_test_site_freed'))).toHaveLength(1);
    expect(h.lines.join('\n')).toContain('could not remove the site in test-manythreads');
    expect(h.lines.join('\n')).not.toContain('slot-token');
  });

  it('asks the cluster nothing when no slot is due, and keeps the slots releasing without a cluster', async () => {
    const quiet = harness([]);
    expect(await teardownPass(quiet.ctx, null, quiet.log)).toEqual({ freed: [], failed: [] });
    const none = harness([{ o_namespace: 'test-card-2', o_task_id: null, o_reason: 'the card is done' }]);
    expect(await teardownPass(none.ctx, null, none.log)).toEqual({ freed: [], failed: [] });
    expect(none.sql.some((s) => s.includes('tasks_test_site_freed'))).toBe(false);
  });
});
