import { parseRepoOriginAllow } from '@manythreads/shared';
import { parseRepos, type AppsRouting, type DeployTarget, type PodConfig, type Resources } from './render.ts';

const DEFAULT_RESOURCES = {
  hermes: { requests: { cpu: '250m', memory: '1Gi' }, limits: { memory: '3Gi' } },
  workbench: { requests: { cpu: '250m', memory: '1Gi' }, limits: { memory: '4Gi' } },
};

/** `MANYTHREADS_HERMES_PODS_DEPLOY_TARGETS`: a JSON list of `{ team, namespace, hosts }` (the chart's `hermesPods.deployTargets`). A damaged or odd entry is dropped. */
export function parseDeployTargets(raw: string | undefined): DeployTarget[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const out: DeployTarget[] = [];
    for (const e of list) {
      const o = e as { team?: unknown; namespace?: unknown; hosts?: unknown };
      if (typeof o.team !== 'string' || typeof o.namespace !== 'string' || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(o.namespace) || o.team === '') continue;
      out.push({ team: o.team, namespace: o.namespace, hosts: Array.isArray(o.hosts) ? o.hosts.filter((h): h is string => typeof h === 'string') : [] });
    }
    return out;
  } catch {
    return [];
  }
}

/** The controller's settings, from the environment the chart sets (values.yaml `hermesPods`). */
export function configFrom(env: NodeJS.ProcessEnv): PodConfig {
  const get = (name: string, fallback: string): string => (env[`MANYTHREADS_HERMES_PODS_${name}`] ?? '').trim() || fallback;
  let resources: { hermes: Resources; workbench: Resources } = DEFAULT_RESOURCES;
  const raw = env['MANYTHREADS_HERMES_PODS_RESOURCES'];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_RESOURCES>;
      resources = { hermes: parsed.hermes ?? DEFAULT_RESOURCES.hermes, workbench: parsed.workbench ?? DEFAULT_RESOURCES.workbench };
    } catch {
      /* keep the defaults */
    }
  }
  return {
    namespace: get('NAMESPACE', 'manythreads-bots'),
    hermesImage: get('HERMES_IMAGE', 'manythreads/hermes-pod:1'),
    workbenchImage: get('WORKBENCH_IMAGE', 'manythreads/workbench:2'),
    workspaceSize: get('WORKSPACE_SIZE', '10Gi'),
    homeSize: get('HOME_SIZE', '2Gi'),
    storageClass: get('STORAGE_CLASS', 'local-path'),
    repos: parseRepos(get('REPOS', '')),
    repoOriginAllow: parseRepoOriginAllow(env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']),
    deployerBot: get('DEPLOYER_BOT', 'deployer'),
    appsPrefix: get('APPS_PREFIX', 'apps-'),
    appsRouting: (get('APPS_ROUTING', 'path') === 'host' ? 'host' : 'path') satisfies AppsRouting,
    appsHost: get('APPS_HOST', 'manythreads.kahf.to'),
    resources,
    deployTargets: parseDeployTargets(env['MANYTHREADS_HERMES_PODS_DEPLOY_TARGETS']),
  };
}
