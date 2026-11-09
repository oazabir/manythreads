import { createHash } from 'node:crypto';
import type { PodRunnerInfo } from '@manythreads/sdk';
import { HOSTNAME_LABEL, isNodeLabelValue, MOVE_HELD_ANNOTATION, MOVING_ANNOTATION, NODE_ANNOTATION, type K8sObject } from '@manythreads/sdk/pods';
import type { ClaudePodConfig } from './config.ts';

// Pure builders: the Kubernetes objects of one Claude Code runner, from plain values. No network, no clock, no randomness (the one generated secret, the bridge's key,
// is drawn by the caller and passed in), so every object can be asserted in a test. One runner is one pod: a pod serves every team on the runner's list.

export const BRIDGE_PORT = 8650;
/** The list of repositories the bridge writes (from the controller's `PUT /internal/repos`) and the repo-sync container reads every few seconds. */
export const REPOS_FILE = '/run/repos/repos.txt';
/** Where the publisher container listens, and the folder the run container shares with it to reach it. */
export const PUBLISH_DIR = '/run/publish';
/** Where each team's push Secret is mounted in the publisher container (and nowhere else): `/etc/publisher-push/<team>/<project>`. */
export const PUSH_ROOT = '/etc/publisher-push';
export const PUBLISHER_UID = 1001;
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
  /** The keeper's ServiceAccount, Role and RoleBinding (P19-06). */
  keeper: string;
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
  return { base, state: `${base}-state`, work: `${base}-work`, key: `${base}-key`, credentials: `${base}-credentials`, config: `${base}-config`, keeper: `${base}-keeper` };
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
export function instructionsFor(teamSlug: string, botSlug: string, mayPublish = false): string {
  return [
    `You run on a shared Claude Code runner, not on a person's machine. Your working folder is /work/${teamSlug}/${botSlug}.`,
    'The team projects are cloned next to it, in the folder /work/<team>/<bot>/<project>; work inside your own folder only.',
    'Do not read, copy or print anything under /state, /etc/bridge or the environment: they hold the runner\'s sign-in and keys, which are not yours to use.',
    'Post your answer and reports with the manythreads tools, not by writing files for people to find.',
    ...(mayPublish
      ? [
          'To hand your work in, commit it on a branch named card-<the first 8 characters of the card id>, then run `mt-publish publish <project> <card id> <the commit> "<title>"` (the pull request text on standard input).',
          'It pushes that branch and opens the pull request. You never hold the push token and never push to the main branch yourself.',
        ]
      : []),
  ].join('\n');
}

/** Git commands every bot may run without a question (decision E5): enough to look, commit on a branch of its own and nothing that reaches the network or rewrites history. */
export const GIT_TOOLS: readonly string[] = ['Bash(git status)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git switch:*)', 'Bash(git checkout -b:*)'];
/** The one extra command of a bot whose definition grants `tasks.pull_request`: the client of the pod's publisher. */
export const PUBLISH_TOOL = 'Bash(mt-publish:*)';

/** The pod has a publisher container: it is turned on and the platform's address is known. */
export const publisherOn = (cfg: ClaudePodConfig): boolean => cfg.publisher.enabled && cfg.serverUrl !== '';

/** `team slug` + `bot slug` of the bots whose definition grants `tasks.pull_request`, as one key per bot. */
export const publisherKey = (teamSlug: string, botSlug: string): string => `${teamSlug}/${botSlug}`;

export function buildBridgeConfig(cfg: ClaudePodConfig, runner: PodRunnerInfo, publishers: ReadonlySet<string> = new Set()): string {
  const profiles: Record<string, unknown> = {};
  const publishing = publisherOn(cfg);
  for (const b of runner.bots) {
    const mayPublish = publishing && publishers.has(publisherKey(b.teamSlug, b.botSlug));
    profiles[profileName(b.teamSlug, b.botSlug)] = {
      agent: 'claude-code',
      workdir: `/work/${b.teamSlug}/${b.botSlug}`,
      modelAliases: cfg.modelAliases,
      extraAllowedTools: [...GIT_TOOLS, ...(mayPublish ? [PUBLISH_TOOL] : [])],
      env: { CLAUDE_CONFIG_DIR, HOME: '/state/home', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      instructions: instructionsFor(b.teamSlug, b.botSlug, mayPublish),
    };
  }
  return JSON.stringify({ profiles, maxConcurrentRuns: runner.maxConcurrent ?? cfg.defaultConcurrency }, null, 2);
}

/** One entry per clone the runner's bots need: the platform's list of projects, per bot of the team. Sent to the bridge as JSON and written into the ConfigMap as lines. */
export function reposFor(runner: PodRunnerInfo, repos: readonly RepoToSync[]): { team: string; bot: string; project: string; branch: string | null; origin: string }[] {
  return runner.bots.flatMap((b) => repos.filter((r) => r.teamSlug === b.teamSlug).map((r) => ({ team: b.teamSlug, bot: b.botSlug, project: r.name, branch: r.branch ?? null, origin: r.origin })));
}

export function buildConfigMap(cfg: ClaudePodConfig, runner: PodRunnerInfo, names: Names, repos: readonly RepoToSync[], publishers: ReadonlySet<string> = new Set()): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: names.config, namespace: cfg.namespace, labels: labelsFor(runner) },
    data: {
      'config.json': buildBridgeConfig(cfg, runner, publishers),
      // one line per clone for the sync step: <team> <bot> <project> <branch or -> <https address>
      'repos.txt': reposFor(runner, repos).map((r) => `${r.team} ${r.bot} ${r.project} ${r.branch ?? '-'} ${r.origin}`).join('\n') + '\n',
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

/**
 * The keeper's identity (P19-06): a ServiceAccount, and a Role that can get and patch this runner's one sign-in Secret and nothing else. Only the keeper container mounts its token.
 * Plain `Role`/`RoleBinding` in the pods namespace; the controller needs `create`, `get` and `patch` on those kinds there (chart: claude-pods.yaml).
 */
export function buildKeeperRbac(cfg: ClaudePodConfig, runner: PodRunnerInfo, names: Names): K8sObject[] {
  const meta = (name: string): K8sObject['metadata'] => ({ name, namespace: cfg.namespace, labels: labelsFor(runner) });
  return [
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(names.keeper), automountServiceAccountToken: false },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: meta(names.keeper), rules: [{ apiGroups: [''], resources: ['secrets'], resourceNames: [names.credentials], verbs: ['get', 'patch'] }] },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: meta(names.keeper),
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: names.keeper },
      subjects: [{ kind: 'ServiceAccount', name: names.keeper, namespace: cfg.namespace }],
    },
  ];
}

export interface DeploymentOptions {
  replicas: number;
  node?: string | null;
  moving?: boolean;
  held?: string | null;
  /** The id of the stored sign-in upload; a new one rolls the pod so it starts from the new file. */
  uploadId?: string | null;
  /** The push Secret of each team on the runner (decision E2): mounted in the publisher container and nowhere else. Empty or absent: no token is mounted. */
  pushSecrets?: readonly { teamSlug: string; secret: string }[];
  /** A hash of the bridge's profiles (config.json). The bridge reads them once at start, so a changed set rolls the pod; the repository list is not part of it. */
  profilesSha?: string | null;
}

/** The Secret of a team's push tokens made by the Hermes pods' controller (`hermes-<team>-push`, one key per project): the same name rule as there, so the two pod kinds read one Secret. */
export function pushSecretName(team: { id: string; slug: string }, disambiguate = false): string {
  const slug = team.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
  return disambiguate ? `hermes-${slug.slice(0, 30)}-${team.id.replace(/-/g, '').slice(0, 8)}-push` : `hermes-${slug}-push`;
}

const NO_PRIVILEGE = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } } as const;

export function buildDeployment(cfg: ClaudePodConfig, runner: PodRunnerInfo, names: Names, opts: DeploymentOptions): K8sObject {
  const podLabels = labelsFor(runner, { 'manythreads.io/pod': names.base });
  const node = isNodeLabelValue(opts.node) ? opts.node : null;
  const publishing = publisherOn(cfg);
  const pushSecrets = publishing ? [...(opts.pushSecrets ?? [])].sort((a, b) => a.teamSlug.localeCompare(b.teamSlug)) : [];
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
        metadata: {
          labels: podLabels,
          ...(opts.uploadId || opts.profilesSha ? { annotations: { ...(opts.uploadId ? { 'manythreads.io/upload-id': opts.uploadId } : {}), ...(opts.profilesSha ? { 'manythreads.io/profiles-sha': opts.profilesSha } : {}) } } : {}),
        },
        spec: {
          // no ServiceAccount token in the pod: neither the bridge nor a bot can talk to the Kubernetes API with the pod's identity
          // The pod's own token stays off. Only the keeper container mounts one (a projected volume below), for the ServiceAccount that can patch the sign-in Secret.
          automountServiceAccountToken: false,
          serviceAccountName: names.keeper,
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
                  // the file is copied when the volume has none, or when the Secret holds a newer upload (its upload-id differs from the one the volume last took)
                  ' && if [ -f /creds/.credentials.json ] && { [ ! -f /state/claude/.credentials.json ] || [ "$(cat /creds/upload-id 2>/dev/null)" != "$(cat /state/claude/.upload-id 2>/dev/null)" ]; }; then' +
                  ' install -o 1000 -g 1000 -m 0600 /creds/.credentials.json /state/claude/.credentials.json && install -o 1000 -g 1000 -m 0600 /creds/upload-id /state/claude/.upload-id; fi',
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
              command: ['/usr/bin/tini', '--', 'node', '--experimental-transform-types', '--disable-warning=ExperimentalWarning', '/opt/bridge/src/main.ts', '--config', '/etc/bridge/config.json', '--listen', `0.0.0.0:${BRIDGE_PORT}`, '--state-dir', '/state/bridge', '--repos-file', REPOS_FILE],
              ports: [{ name: 'bridge', containerPort: BRIDGE_PORT }],
              env: [
                { name: 'AGENT_BRIDGE_API_KEY', valueFrom: { secretKeyRef: { name: names.key, key: 'api-key' } } },
                { name: 'HOME', value: '/state/home' },
                { name: 'CLAUDE_CONFIG_DIR', value: CLAUDE_CONFIG_DIR },
              ],
              securityContext: { ...NO_PRIVILEGE, readOnlyRootFilesystem: true },
              // /health wants the key, which a probe cannot carry: the port answering is the signal
              readinessProbe: { tcpSocket: { port: BRIDGE_PORT }, initialDelaySeconds: 3, periodSeconds: 5, failureThreshold: 12 },
              livenessProbe: { tcpSocket: { port: BRIDGE_PORT }, initialDelaySeconds: 30, periodSeconds: 20, failureThreshold: 6 },
              resources: cfg.resources,
              volumeMounts: [
                { name: 'state', mountPath: '/state' },
                { name: 'work', mountPath: '/work' },
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'config', mountPath: '/etc/bridge', readOnly: true },
                // the controller's repository list lands here (the bridge writes it, the repo-sync container reads it)
                { name: 'repos', mountPath: '/run/repos' },
                // the socket the `mt-publish` command talks to; the publisher container owns the other end. No token, no Secret and no push folder is mounted in this container.
                ...(publishing ? [{ name: 'publish', mountPath: PUBLISH_DIR }] : []),
              ],
            },
            {
              // Copies a renewed sign-in file back into its Secret (keeper.mjs). Reads the sign-in folder read-only; has the one Kubernetes token in the pod.
              name: 'keeper',
              image: cfg.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['node', '/opt/claude-pod/keeper.mjs'],
              env: [
                { name: 'KEEPER_NAMESPACE', value: cfg.namespace },
                { name: 'KEEPER_SECRET', value: names.credentials },
              ],
              securityContext: { ...NO_PRIVILEGE, readOnlyRootFilesystem: true },
              resources: { requests: { cpu: '5m', memory: '24Mi' }, limits: { memory: '96Mi' } },
              volumeMounts: [
                { name: 'state', mountPath: '/state/claude', subPath: 'claude', readOnly: true },
                { name: 'keeper-token', mountPath: '/var/run/secrets/keeper', readOnly: true },
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
                { name: 'repos', mountPath: '/run/repos', readOnly: true },
              ],
            },
            ...(publishing
              ? [
                  {
                    // The publisher (P19-09): pushes a bot's branch and opens its pull request. The only container that mounts a team's push Secret. It has its own user, a read-only root, the work
                    // volume read-only and no Kubernetes token; it learns which team and bot a request comes from by asking the platform with the run's own token, never from the request.
                    name: 'publisher',
                    image: cfg.image,
                    imagePullPolicy: 'IfNotPresent',
                    command: ['node', '/opt/claude-pod/publisher.mjs', 'serve'],
                    env: [
                      { name: 'PUBLISHER_SERVER_URL', value: cfg.serverUrl },
                      { name: 'HOME', value: '/tmp' },
                    ],
                    securityContext: { ...NO_PRIVILEGE, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: PUBLISHER_UID, runAsGroup: PUBLISHER_UID },
                    resources: cfg.publisher.resources,
                    volumeMounts: [
                      { name: 'work', mountPath: '/work', readOnly: true },
                      { name: 'publish', mountPath: PUBLISH_DIR },
                      { name: 'publisher-tmp', mountPath: '/tmp' },
                      ...pushSecrets.map((p, i) => ({ name: `push-${i}`, mountPath: `${PUSH_ROOT}/${p.teamSlug}`, readOnly: true })),
                    ],
                  },
                ]
              : []),
          ],
          volumes: [
            { name: 'state', persistentVolumeClaim: { claimName: names.state } },
            { name: 'work', persistentVolumeClaim: { claimName: names.work } },
            { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
            { name: 'config', configMap: { name: names.config } },
            { name: 'repos', emptyDir: { sizeLimit: '8Mi' } },
            ...(publishing
              ? [
                  { name: 'publish', emptyDir: { sizeLimit: '1Mi' } },
                  // the publisher's scratch space (a private copy of one token file per request, removed at the end); memory, so no token reaches a disk
                  { name: 'publisher-tmp', emptyDir: { medium: 'Memory', sizeLimit: '32Mi' } },
                  // optional: the Secret exists only once a lead has saved a token for a project of the team. Files are readable by the publisher's user; no other container mounts them.
                  ...pushSecrets.map((p, i) => ({ name: `push-${i}`, secret: { secretName: p.secret, defaultMode: 0o444, optional: true } })),
                ]
              : []),
            {
              name: 'keeper-token',
              projected: {
                sources: [
                  { serviceAccountToken: { path: 'token', expirationSeconds: 3600 } },
                  { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
                ],
              },
            },
            // optional: the Secret exists only once an admin has uploaded a sign-in file
            { name: 'creds', secret: { secretName: names.credentials, defaultMode: 0o444, optional: true } },
          ],
        },
      },
    },
  };
}
