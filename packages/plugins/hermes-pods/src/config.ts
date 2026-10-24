import { parseRepos, type PodConfig, type Resources } from './render.ts';

const DEFAULT_RESOURCES = {
  hermes: { requests: { cpu: '250m', memory: '1Gi' }, limits: { memory: '3Gi' } },
  workbench: { requests: { cpu: '250m', memory: '1Gi' }, limits: { memory: '4Gi' } },
};

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
    workbenchImage: get('WORKBENCH_IMAGE', 'manythreads/workbench:1'),
    workspaceSize: get('WORKSPACE_SIZE', '10Gi'),
    homeSize: get('HOME_SIZE', '2Gi'),
    storageClass: get('STORAGE_CLASS', 'local-path'),
    repos: parseRepos(get('REPOS', '')),
    repoOriginAllow: get('REPO_ORIGIN_ALLOW', '').split(',').map((x) => x.trim()).filter((x) => x.startsWith('https://')),
    deployerBot: get('DEPLOYER_BOT', 'deployer'),
    appsPrefix: get('APPS_PREFIX', 'apps-'),
    appsHost: get('APPS_HOST', 'apps.manythreads.kahf.to'),
    resources,
  };
}
