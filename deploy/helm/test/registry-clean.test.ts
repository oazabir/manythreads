import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script of the chart (files/registry-clean.mjs), run by node in the CronJob; no types of its own
import { plan, refsOf } from '../manythreads/files/registry-clean.mjs';
import { haveHelm, render, type K8sDoc } from './chart.ts';

// P31-05: the registry's nightly clean-up. What it keeps (the pure `plan`), and what the chart renders around it.

interface Entry { repo: string; tag: string; digest: string; created: string; layers: string[]; index: boolean }
const img = (repo: string, tag: string, created: string, layers: string[] = [`l-${repo}-${tag}`], digest = `sha256:${repo}-${tag}`): Entry => ({
  repo, tag, digest, created, layers, index: false,
});
const none = { tags: new Set<string>(), digests: new Set<string>() };
const keep = { keepTags: 2, keepCacheDays: 14, now: Date.parse('2026-11-20T00:00:00Z') };
const deleted = (entries: Entry[], inUse = none): string[] =>
  (plan(entries, inUse, keep) as { repo: string; tags: string[] }[]).flatMap((d) => d.tags.map((t) => `${d.repo}:${t}`)).sort();

describe('what the registry clean-up deletes', () => {
  it('keeps the newest two tags of a repository by the image time, not by the name', () => {
    const e = [img('t/server', 'aaa', '2026-11-18T00:00:00Z'), img('t/server', 'zzz', '2026-11-10T00:00:00Z'), img('t/server', 'mmm', '2026-11-19T00:00:00Z')];
    expect(deleted(e)).toEqual(['t/server:zzz']);
  });

  it('keeps every tag under platform/ (the database image) however old', () => {
    const e = ['a', 'b', 'c', 'd'].map((t, i) => img('platform/postgres-cnpg', t, `2026-01-0${i + 1}T00:00:00Z`));
    expect(deleted(e)).toEqual([]);
  });

  it('keeps an old tag a pod uses, by tag or by digest', () => {
    const e = [img('t/web', 'new1', '2026-11-19'), img('t/web', 'new2', '2026-11-18'), img('t/web', 'old1', '2026-11-01'), img('t/web', 'old2', '2026-11-02')];
    expect(deleted(e, { tags: new Set(['t/web:old1']), digests: new Set(['sha256:t/web-old2']) })).toEqual([]);
  });

  it('never deletes a digest a kept tag points at (deleting a manifest removes every tag on it)', () => {
    const shared = 'sha256:same';
    const e = [img('t/server', 'new', '2026-11-19', ['x'], shared), img('t/server', 'mid', '2026-11-18'), img('t/server', 'old', '2026-11-01', ['x'], shared)];
    expect(deleted(e)).toEqual([]);
  });

  it('keeps an image index (no single time to sort by), deletes nothing it cannot date', () => {
    const e = [img('t/server', 'a', '2026-11-19'), img('t/server', 'b', '2026-11-18'), { ...img('t/server', 'multi', ''), index: true }];
    expect(deleted(e)).toEqual([]);
  });

  it("keeps kaniko's cache entries whose layers a kept image holds (no space) and those younger than two weeks", () => {
    const e = [
      img('t/server', 'new', '2026-11-19', ['install', 'src2']),
      img('t/server', 'prev', '2026-11-18', ['install', 'src1']),
      img('t/cache', 'k-install', '2026-11-01', ['install']),
      img('t/cache', 'k-webinstall', '2026-11-08', ['webinstall']),
      img('t/cache', 'k-newest', '2026-11-19', ['webbuild3']),
      img('t/cache', 'k-old', '2026-11-02', ['webbuild1']),
      img('t/cache', 'k-undated', '', ['x9']),
    ];
    // an entry with no readable time is kept (the script itself stops before it gets here for an image)
    expect(deleted(e)).toEqual(['t/cache:k-old']);
  });

  it('reads the registry tag or digest out of the image names pods report', () => {
    const hosts = ['registry.local:5000'];
    expect(refsOf('registry.local:5000/test-manythreads/server:8ac364560523', hosts)).toEqual({ tag: 'test-manythreads/server:8ac364560523', digest: undefined });
    expect(refsOf('registry.local:5000/platform/pg:19@sha256:abc', hosts)).toEqual({ tag: 'platform/pg:19', digest: 'sha256:abc' });
    expect(refsOf('docker.io/manythreads/server:1', hosts)).toEqual({ digest: undefined });
  });
});

describe.skipIf(!haveHelm)('the registry clean-up the chart renders (live values)', () => {
  const docs = render('live');
  const find = (kind: string, name: string, ns = 'manythreads-registry'): K8sDoc => {
    const d = docs.find((x) => x.kind === kind && x.metadata.name === name && x.metadata.namespace === ns);
    if (!d) throw new Error(`${kind}/${ns}/${name} not rendered`);
    return d;
  };

  it('a nightly CronJob that never overlaps; the collection never deletes untagged manifests', () => {
    const cj = find('CronJob', 'registry-clean');
    expect(cj.spec.concurrencyPolicy).toBe('Forbid');
    const pod = cj.spec.jobTemplate.spec.template.spec;
    expect(pod.initContainers.map((c: { name: string }) => c.name)).toEqual(['clean', 'gc']);
    expect(pod.containers.map((c: { name: string }) => c.name)).toEqual(['scale-up']);
    const gc = pod.initContainers[1];
    expect(gc.args.join(' ')).toContain('registry garbage-collect');
    expect(JSON.stringify(cj)).not.toContain('delete-untagged');
  });

  it('narrow rights: the registry Deployment scale and its pods; in a deploy target only listing pods and Jobs', () => {
    const own = find('Role', 'registry-clean');
    expect(own.rules).toEqual([
      { apiGroups: ['apps'], resources: ['deployments/scale'], resourceNames: ['registry'], verbs: ['get', 'patch'] },
      { apiGroups: [''], resources: ['pods'], verbs: ['list'] },
    ]);
    const reader = find('Role', 'registry-clean-reader', 'test-manythreads');
    for (const r of reader.rules) expect(r.verbs).toEqual(['list']);
    expect(reader.rules.flatMap((r: { resources: string[] }) => r.resources).sort()).toEqual(['jobs', 'pods']);
  });

  it('the registry admits the clean-up pod, and the clean-up pod may call only the registry and the Kubernetes API', () => {
    const reg = find('NetworkPolicy', 'registry');
    expect(JSON.stringify(reg.spec.ingress)).toContain('registry-clean');
    const own = find('NetworkPolicy', 'registry-clean');
    expect(own.spec.egress).toHaveLength(2);
  });

  it('the script the ConfigMap carries is the file the tests above checked', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { chartDir } = await import('./chart.ts');
    expect(find('ConfigMap', 'registry-clean-script').data['registry-clean.mjs']).toBe(readFileSync(join(chartDir, 'files/registry-clean.mjs'), 'utf8'));
  });
});
