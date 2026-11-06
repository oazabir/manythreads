import { createHash } from 'node:crypto';
import type { PodRunnerInfo } from '@manythreads/sdk';
import { HOSTNAME_LABEL, isNodeLabelValue, MOVE_HELD_ANNOTATION, MOVING_ANNOTATION, NODE_ANNOTATION, type K8sObject } from '@manythreads/sdk/pods';
import type { ClaudePodConfig } from './config.ts';

// Pure builders: the Kubernetes objects of one Claude Code runner, from plain values. No network, no clock, no randomness (the one generated secret, the bridge's key,
// is drawn by the caller and passed in), so every object can be asserted in a test. One runner is one pod: a pod serves every team on the runner's list.

export const BRIDGE_PORT = 8650;
export const COMPONENT = 'claude-pod';
export const MANAGED_BY = 'manythreads-claude-pods';
/** The folder a runner's `claude` keeps its sign-in file in (a folder of the state volume, so a refreshed file survives a restart). */
export const CLAUDE_CONFIG_DIR = '/state/claude';

export interface Names {
  /** The Deployment and the Service: `claude-<runner>`. */
  base: string;
  state: string;
  work: string;
  key: string;
  /** The sign-in Secret (written by the upload route, P19-06; the controller only reads whether it exists). */
  credentials: string;
  config: string;
}

/**
 * A runner's name as a Kubernetes name. A runner name may hold "." and "_" and run to 63 characters; a Service name may not. A name that fits as it is stays as it is; any other
 * is cut, mapped to "-", and given six letters of its own hash so that two runners never share a name.
 */
export function slugForRunner(name: string): string {
  if (/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(name)) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 6);
  const clean = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return `${clean === '' ? 'r' : clean}-${hash}`;
}

export function namesFor(runnerName: string): Names {
  const base = `claude-${slugForRunner(runnerName)}`;
  return { base, state: `${base}-state`, work: `${base}-work`, key: `${base}-key`, credentials: `${base}-credentials`, config: `${base}-config` };
}

export function labelsFor(runner: Pick<PodRunnerInfo, 'id' | 'name'>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'manythreads',
    'app.kubernetes.io/component': COMPONENT,
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'manythreads.io/runner': runner.name,
    'manythreads.io/runner-id': runner.id,
    ...extra,
  };
}

/** The name of a bot's profile in the bridge: `<team>--<bot>`. The rule the bridge is asked by is the same, `{team}--{bot}`. */
export const profileName = (teamSlug: string, botSlug: string): string => `${teamSlug}--${botSlug}`;

/** What a repository of a project looks like to the sync step. */
export interface RepoToSync {
  teamSlug: string;
  name: string;
  origin: string;
  branch?: string;
}

/** The note appended after a bot's own definition in every run: where it runs and what it must leave alone. */
export function instructionsFor(teamSlug: string, botSlug: string): string {
  return [
    `You run on a shared Claude Code runner, not on a person's machine. Your working folder is /work/${teamSlug}/${botSlug}.`,
    'The team projects are cloned next to it, in the folder /work/<team>/<bot>/<project>; work inside your own folder only.',
    'Do not read, copy or print anything under /state, /etc/bridge or the environment: they hold the runner\'s sign-in and keys, which are not yours to use.',
    'Post your answer and reports with the manythreads tools, not by writing files for people to find.',
  ].join('\n');
}

export function buildBridgeConfig(cfg: ClaudePodConfig, runner: PodRunnerInfo): string {
  const profiles: Record<string, unknown> = {};
  for (const b of runner.bots) {
    profiles[profileName(b.teamSlug, b.botSlug)] = {
      agent: 'claude-code',
      workdir: `/work/${b.teamSlug}/${b.botSlug}`,
      modelAliases: cfg.modelAliases,
      env: { CLAUDE_CONFIG_DIR, HOME: '/state/home', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      instructions: instructionsFor(b.teamSlug, b.botSlug),
    };
  }
  return JSON.stringify({ profiles, maxConcurrentRuns: runner.maxConcurrent ?? cfg.defaultConcurrency }, null, 2);
}

export function buildConfigMap(cfg: ClaudePodConfig, runner: PodRunnerInfo, names: Names, repos: readonly RepoToSync[]): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: names.config, namespace: cfg.namespace, labels: labelsFor(runner) },
    data: {
      'config.json': buildBridgeConfig(cfg, runner),
      // one line per clone for the sync step: <team> <bot> <project> <branch or -> <https address>
      'repos.txt': runner.bots.flatMap((b) => repos.filter((r) => r.teamSlug === b.teamSlug).map((r) => `${b.teamSlug} ${b.botSlug} ${r.name} ${r.branch ?? '-'} ${r.origin}`)).join('\n') + '\n',
    },
  };
}

export function buildKeySecret(cfg: ClaudePodConfig, runner: PodRunnerInfo, names: Names, apiKey: string): K8sObject {
  return { apiVersion: 'v1', kind: 'Secret', metadata: { name: names.key, namespace: cfg.namespace, labels: labelsFor(runner) }, type: 'Opaque', stringData: { 'api-key': apiKey } };
}

export function buildPvc(cfg: ClaudePodConfig, runner: PodRunnerInfo, name: string, size: string, node: string | null = null): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: cfg.namespace, labels: labelsFor(runner), ...(isNodeLabelValue(node) ? { annotations: { [NODE_ANNOTATION]: node } } : {}) },
    spec: { accessModes: ['ReadWriteOnce'], storageClassName: cfg.storageClass, resources: { requests: { storage: size } } },
  };
}

export function buildService(cfg: ClaudePodConfig, runner: PodRunnerInfo, names: Names): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: names.base, namespace: cfg.namespace, labels: labelsFor(runner) },
    spec: { selector: { 'manythreads.io/pod': names.base }, ports: [{ name: 'bridge', port: BRIDGE_PORT, targetPort: BRIDGE_PORT }] },
  };
}

export interface DeploymentOptions {
  replicas: number;
  node?: string | null;
  moving?: boolean;
  held?: string | null;
}

const NO_PRIVILEGE = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } } as const;

export function buildDeployment(cfg: ClaudePodConfig, runner: PodRunnerInfo, names: Names, opts: DeploymentOptions): K8sObject {
  const podLabels = labelsFor(runner, { 'manythreads.io/pod': names.base });
  const node = isNodeLabelValue(opts.node) ? opts.node : null;
  const annotations: Record<string, string> = {};
  if (opts.moving === true && node !== null) annotations[MOVING_ANNOTATION] = node;
  if (isNodeLabelValue(opts.held)) annotations[MOVE_HELD_ANNOTATION] = opts.held;
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: names.base, namespace: cfg.namespace, labels: labelsFor(runner), ...(Object.keys(annotations).length > 0 ? { annotations } : {}) },
    spec: {
      replicas: opts.replicas,
      // both volumes are ReadWriteOnce: the old pod lets go of them before the new one starts
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'manythreads.io/pod': names.base } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          // no ServiceAccount token in the pod: neither the bridge nor a bot can talk to the Kubernetes API with the pod's identity
          automountServiceAccountToken: false,
          ...(node !== null ? { nodeSelector: { [HOSTNAME_LABEL]: node } } : {}),
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 30,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          initContainers: [
            {
              // The kubelet creates a volume's folders owned by root. This step only makes the folders and hands them to the run user; it copies the sign-in file
              // in when the volume has none yet (byte for byte, mode 0600), and touches nothing else.
              name: 'prepare',
              image: cfg.image,
              imagePullPolicy: 'IfNotPresent',
              command: [
                'sh',
                '-c',
                'install -d -o 1000 -g 1000 -m 0700 /state/claude /state/home /state/bridge && install -d -o 1000 -g 1000 -m 0755 /work' +
                  ' && if [ -f /creds/.credentials.json ] && [ ! -f /state/claude/.credentials.json ]; then install -o 1000 -g 1000 -m 0600 /creds/.credentials.json /state/claude/.credentials.json; fi',
              ],
              securityContext: { runAsNonRoot: false, runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] }, seccompProfile: { type: 'RuntimeDefault' } },
              resources: { limits: { memory: '64Mi' } },
              volumeMounts: [
                { name: 'state', mountPath: '/state' },
                { name: 'work', mountPath: '/work' },
                { name: 'creds', mountPath: '/creds', readOnly: true },
              ],
            },
          ],
          containers: [
            {
              name: 'bridge',
              image: cfg.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['node', '/opt/bridge/src/main.ts', '--config', '/etc/bridge/config.json', '--listen', `0.0.0.0:${BRIDGE_PORT}`, '--state-dir', '/state/bridge'],
              ports: [{ name: 'bridge', containerPort: BRIDGE_PORT }],
              env: [
                { name: 'AGENT_BRIDGE_API_KEY', valueFrom: { secretKeyRef: { name: names.key, key: 'api-key' } } },
                { name: 'HOME', value: '/state/home' },
                { name: 'CLAUDE_CONFIG_DIR', value: CLAUDE_CONFIG_DIR },
              ],
              securityContext: { ...NO_PRIVILEGE, readOnlyRootFilesystem: true },
              readinessProbe: { httpGet: { path: '/health', port: BRIDGE_PORT }, initialDelaySeconds: 3, periodSeconds: 5, failureThreshold: 12 },
              livenessProbe: { httpGet: { path: '/health', port: BRIDGE_PORT }, initialDelaySeconds: 30, periodSeconds: 20, failureThreshold: 6 },
              resources: cfg.resources,
              volumeMounts: [
                { name: 'state', mountPath: '/state' },
                { name: 'work', mountPath: '/work' },
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'config', mountPath: '/etc/bridge', readOnly: true },
              ],
            },
            {
              // Clones and fetches the projects of the teams on the list into /work. It has no Kubernetes token and no access to the sign-in folder.
              name: 'repo-sync',
              image: cfg.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '/opt/claude-pod/repo-sync.sh'],
              env: [{ name: 'HOME', value: '/tmp' }],
              securityContext: { ...NO_PRIVILEGE, readOnlyRootFilesystem: true },
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '256Mi' } },
              volumeMounts: [
                { name: 'work', mountPath: '/work' },
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'config', mountPath: '/etc/bridge', readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: 'state', persistentVolumeClaim: { claimName: names.state } },
            { name: 'work', persistentVolumeClaim: { claimName: names.work } },
            { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
            { name: 'config', configMap: { name: names.config } },
            // optional: the Secret exists only once an admin has uploaded a sign-in file
            { name: 'creds', secret: { secretName: names.credentials, defaultMode: 0o444, optional: true } },
          ],
        },
      },
    },
  };
}
