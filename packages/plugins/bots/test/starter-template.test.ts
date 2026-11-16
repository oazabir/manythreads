import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

// P27-18: templates/_starter is the content of the public starter repository the setup wizard's first delivery works in. It must run its own test,
// and the cluster objects its deploy README applies must have the exact shape the apps namespace admits (the chart's `manythreads-apps-guard`).
// Pure files and one child process, no database.

const STARTER = fileURLToPath(new URL('../../../../templates/_starter/', import.meta.url));

type PodSpec = {
  securityContext: Record<string, unknown>;
  containers: Array<{ securityContext: Record<string, unknown> }>;
  hostNetwork?: boolean;
  volumes: Array<{ hostPath?: unknown; configMap: { name: string } }>;
};
type Obj = { kind: string; metadata?: { name?: string; annotations?: Record<string, string> }; spec?: Record<string, unknown> };

async function manifest(team: string, ns: string, host: string, tag: string): Promise<Obj[]> {
  const raw = await readFile(`${STARTER}deploy/preview/starter.yaml`, 'utf8');
  const filled = raw.replaceAll('__TAG__', tag).replaceAll('__TEAM__', team).replaceAll('__HOST__', host).replaceAll('__NAMESPACE__', ns);
  expect(filled.split('\n').filter((l) => !l.startsWith('#')).join('\n')).not.toMatch(/__[A-Z]+__/);
  return parseAllDocuments(filled).map((d) => d.toJS() as Obj);
}

describe('the starter template', () => {
  it('passes its own test with nothing installed', () => {
    const r = spawnSync(process.execPath, ['--test'], { cwd: STARTER, encoding: 'utf8', timeout: 60_000 });
    expect(r.stdout + r.stderr).toMatch(/# pass 4/);
    expect(r.status).toBe(0);
  });

  it('has no dependency to install', async () => {
    const pkg = JSON.parse(await readFile(`${STARTER}package.json`, 'utf8')) as Record<string, unknown>;
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg['devDependencies']).toBeUndefined();
  });

  it('its objects have the shape an apps namespace admits (path routing)', async () => {
    const docs = await manifest('engineering', 'apps-engineering', 'site.example', 'abcdef012345');
    expect(docs.map((d) => d.kind)).toEqual(['Deployment', 'Service', 'Ingress']);
    const [deployment, service, ingress] = docs as [Obj, Obj, Obj];
    // Ingress: the platform's own host, /apps/<team>/<app> with pathType Prefix, exactly the one traefik annotation, no tls
    expect(ingress.metadata?.annotations).toEqual({ 'traefik.ingress.kubernetes.io/router.middlewares': 'apps-engineering-apps-path@kubernetescrd' });
    expect(ingress.spec?.['tls']).toBeUndefined();
    expect(ingress.spec?.['defaultBackend']).toBeUndefined();
    const rule = (ingress.spec?.['rules'] as Array<{ host: string; http: { paths: Array<{ path: string; pathType: string }> } }>)[0]!;
    expect(rule.host).toBe('site.example');
    expect(rule.http.paths[0]!).toMatchObject({ path: '/apps/engineering/starter', pathType: 'Prefix' });
    expect(rule.http.paths[0]!.path).toMatch(/^\/apps\/[a-z0-9-]+\/[a-z0-9]+(-[a-z0-9]+)*$/);
    // Service: ClusterIP, no external address
    expect(service.spec?.['type']).toBe('ClusterIP');
    expect(service.spec?.['externalIPs']).toBeUndefined();
    // Pod: passes pod security "restricted"
    const pod = (deployment.spec?.['template'] as { spec: PodSpec }).spec;
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
    const c = pod.containers[0]!;
    expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    expect(c.securityContext.privileged).toBeUndefined();
    expect(pod.hostNetwork).toBeUndefined();
    expect(pod.volumes.every((v) => v.hostPath === undefined)).toBe(true);
    // the ConfigMap the README creates is the one the Deployment mounts
    expect(pod.volumes[0]!.configMap.name).toBe('starter-src-abcdef012345');
  });

  it('its deploy README names only what the site gives it, never a fixed host', async () => {
    const text = await readFile(`${STARTER}deploy/preview/README.md`, 'utf8');
    expect(text).toContain('/apps/');
    expect(text).toContain('starter-src-');
    expect(text).not.toMatch(/kahf|test-manythreads|registry\.local/i);
    expect(text).not.toMatch(/rm -rf/);
  });
});
