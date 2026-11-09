import { parseRepoOriginAllow } from '@manythreads/shared';

/** The Claude pod controller's settings, from the environment the chart sets (values.yaml `claudePod`). */
export interface ClaudePodConfig {
  /** Namespace the pods live in (the server's pods namespace, shared with the Hermes pods). */
  namespace: string;
  /** The image that runs the bridge and the `claude` command. */
  image: string;
  storageClass: string;
  /** Size of the runner's work volume (the clones and what the bots write). */
  workSize: string;
  /** Size of the state volume (the sign-in folder and the bridge's session list). */
  stateSize: string;
  /** Runs at once when the runner does not say (1 to 4). */
  defaultConcurrency: number;
  resources: { requests?: Record<string, string>; limits?: Record<string, string> };
  /** The machines an admin may choose (the same list as the Hermes pods); a move goes only to one of these. Empty: every machine. */
  allowedNodes: string[];
  /** https:// prefixes a project repository may be cloned from; empty = none. */
  repoOriginAllow: string[];
  /** Models a bot's `model.alias` stands for in the Claude command. */
  modelAliases: Record<string, string>;
  /** The platform's address inside the cluster: where the publisher container asks `GET /api/runs/self`. Empty: the pod gets no publisher. */
  serverUrl: string;
  /** The publisher: the third container, the only one that holds a team's push token (P19-09, docs/plugins/claude-pods.md). */
  publisher: { enabled: boolean; resources: { requests?: Record<string, string>; limits?: Record<string, string> } };
}

const DEFAULT_RESOURCES = { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '2Gi' } };
const DEFAULT_ALIASES = { smart: 'opus', fast: 'haiku', default: 'sonnet' };
const DEFAULT_PUBLISHER_RESOURCES = { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } };

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function configFrom(env: NodeJS.ProcessEnv): ClaudePodConfig {
  const get = (name: string, fallback: string): string => (env[`MANYTHREADS_CLAUDE_PODS_${name}`] ?? '').trim() || fallback;
  const conc = Math.floor(Number(get('DEFAULT_CONCURRENCY', '2')));
  return {
    namespace: get('NAMESPACE', get('HERMES_NAMESPACE', 'manythreads-bots')),
    image: get('IMAGE', 'manythreads/claude-pod:1'),
    storageClass: get('STORAGE_CLASS', 'local-path'),
    workSize: get('WORK_SIZE', '10Gi'),
    stateSize: get('STATE_SIZE', '256Mi'),
    defaultConcurrency: Number.isFinite(conc) && conc >= 1 && conc <= 4 ? conc : 2,
    resources: parseJson(env['MANYTHREADS_CLAUDE_PODS_RESOURCES'], DEFAULT_RESOURCES),
    allowedNodes: (env['MANYTHREADS_BOT_RUNNERS_ALLOWED_NODES'] ?? '').split(/[\s,]+/).filter((n) => n !== ''),
    repoOriginAllow: parseRepoOriginAllow(env['MANYTHREADS_CLAUDE_PODS_REPO_ORIGIN_ALLOW']),
    modelAliases: parseJson(env['MANYTHREADS_CLAUDE_PODS_MODEL_ALIASES'], DEFAULT_ALIASES),
    // the server pod's address in the cluster; the chart sets MANYTHREADS_INCLUSTER_URL whenever the pods namespace is on
    serverUrl: (env['MANYTHREADS_CLAUDE_PODS_SERVER_URL'] ?? env['MANYTHREADS_INCLUSTER_URL'] ?? '').trim().replace(/\/+$/, ''),
    publisher: {
      enabled: !['0', 'false', 'off'].includes((env['MANYTHREADS_CLAUDE_PODS_PUBLISHER'] ?? '').trim().toLowerCase()),
      resources: parseJson(env['MANYTHREADS_CLAUDE_PODS_PUBLISHER_RESOURCES'], DEFAULT_PUBLISHER_RESOURCES),
    },
  };
}
