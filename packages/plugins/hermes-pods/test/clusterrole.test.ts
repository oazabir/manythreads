import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P19-08: the one cluster-wide permission the server gets is a read of the cluster's machines. This renders the chart with `helm template` (skipped where
// helm is absent) and checks every cluster-scoped role it makes: only `get` and `list`, only on `nodes`, bound only to the server's account.

const chart = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../deploy/helm/manythreads');
const haveHelm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;
const render = (extra: string[]): { code: number; out: string } => {
  const r = spawnSync('helm', ['template', 't', chart, '-f', resolve(chart, 'values-live.yaml'), ...extra], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const docsOf = (out: string, kind: string): string[] => out.split(/^---$/m).filter((d) => new RegExp(`^kind: ${kind}$`, 'm').test(d));
/** Every `verbs: [...]` of a rule document, as a flat list. */
const verbsOf = (doc: string): string[] => [...doc.matchAll(/verbs:\s*\[([^\]]*)\]/g)].flatMap((m) => m[1]!.split(',').map((v) => v.trim()).filter((v) => v !== ''));
const resourcesOf = (doc: string): string[] => [...doc.matchAll(/resources:\s*\[([^\]]*)\]/g)].flatMap((m) => m[1]!.split(',').map((v) => v.trim()).filter((v) => v !== ''));

describe.skipIf(!haveHelm)('the chart (P19-08)', () => {
  it('makes exactly one ClusterRole: get and list on nodes, and nothing that can change anything', () => {
    const r = render([]);
    expect(r.code, r.out).toBe(0);
    const roles = docsOf(r.out, 'ClusterRole');
    expect(roles).toHaveLength(1);
    const role = roles[0]!;
    expect(role).toContain('name: default-manythreads-nodes-reader');
    expect(resourcesOf(role)).toEqual(['nodes']);
    expect(verbsOf(role).sort()).toEqual(['get', 'list']);
    for (const verb of ['create', 'update', 'patch', 'delete', 'deletecollection', 'watch', 'escalate', 'bind', 'impersonate', '*']) expect(verbsOf(role), verb).not.toContain(verb);
    expect(role).not.toMatch(/resourceNames|nonResourceURLs/);
  });

  it('binds it to the server\'s ServiceAccount alone, and to no group or user', () => {
    const bindings = docsOf(render([]).out, 'ClusterRoleBinding');
    expect(bindings).toHaveLength(1);
    const b = bindings[0]!;
    expect(b).toContain('kind: ClusterRole, name: default-manythreads-nodes-reader');
    expect([...b.matchAll(/kind: (ServiceAccount|User|Group)\b/g)].map((m) => m[1])).toEqual(['ServiceAccount']);
    expect(b).toContain('name: manythreads-server');
  });

  it('the only delete on a volume claim is in the pods namespace Role (a move), never cluster-wide', () => {
    const out = render([]).out;
    const clusterWide = docsOf(out, 'ClusterRole').join('\n');
    expect(clusterWide).not.toContain('persistentvolumeclaims');
    const role = docsOf(out, 'Role').find((d) => d.includes('name: manythreads-hermes-pods-controller'))!;
    expect(role).toContain('namespace: manythreads-bots');
    expect(role).toMatch(/resources: \[persistentvolumeclaims\]\s+verbs: \[delete\]/);
  });

  it('adds no cluster role when the pods are off, and passes the allowlist to the server', () => {
    const off = spawnSync('helm', ['template', 't', chart], { encoding: 'utf8' });
    expect(off.status, off.stderr).toBe(0);
    expect(docsOf(off.stdout, 'ClusterRole')).toHaveLength(0);
    const on = render(['--set', 'botRunners.allowedNodes[0]=ubuntu-vm', '--set', 'botRunners.allowedNodes[1]=worker-2']);
    expect(on.code, on.out).toBe(0);
    expect(on.out).toContain('name: MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES, value: "ubuntu-vm,worker-2"');
    expect(render([]).out).toContain('name: MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES, value: ""');
  });
});
