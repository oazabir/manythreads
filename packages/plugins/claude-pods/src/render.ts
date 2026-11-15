import { createHash } from 'node:crypto';
import type { PodAgent, PodRunnerInfo } from '@manythreads/sdk';
import { HOSTNAME_LABEL, isNodeLabelValue, MOVE_HELD_ANNOTATION, MOVING_ANNOTATION, NODE_ANNOTATION, type K8sObject } from '@manythreads/sdk/pods';
import type { ClaudePodConfig } from './config.ts';

// Pure builders: the Kubernetes objects of one Claude Code runner, from plain values. No network, no clock, no randomness (the one generated secret, the bridge's key,
// is drawn by the caller and passed in), so every object can be asserted in a test. One runner is one pod: a pod serves every team on the runner's list.

export const BRIDGE_PORT = 8650;
/** The scratch folder of the repo-sync container: a memory volume that only that container mounts (deploy/images/agent-pod/repo-sync.sh). */
export const REPO_SYNC_SCRATCH = '/run/sync';
/** The list of repositories the bridge writes (from the controller's `PUT /internal/repos`) and the repo-sync container reads every few seconds. */
export const REPOS_FILE = '/run/repos/repos.txt';
/** Where the publisher container listens, and the folder the run container shares with it to reach it. */
export const PUBLISH_DIR = '/run/publish';
/** Where each team's push Secret is mounted in the publisher container (and nowhere else): `/etc/publisher-push/<team>/<project>`. */
export const PUSH_ROOT = '/etc/publisher-push';
export const PUBLISHER_UID = 1001;
/** Where a team's deployer kubeconfig Secret is mounted in the run container: `/etc/deployer/<team>/<key>`. Only a pod of one team gets it (see `deployMountsFor`). */
export const DEPLOY_ROOT = '/etc/deployer';
/** The pnpm store of the pod: one on the work volume (the same file system as the clones, so an install links files instead of copying them). */
export const PNPM_STORE = '/work/.pnpm-store';
/** The label that lets a pod reach the Kubernetes API (chart: claude-pods.yaml): the keeper's and the deployer's pod only. */
export const KUBE_API_LABEL = 'manythreads.io/kube-api';
export const COMPONENT = 'claude-pod';
export const MANAGED_BY = 'manythreads-claude-pods';
/** The folder a runner's `claude` keeps its sign-in file in (a folder of the state volume, so a refreshed file survives a restart). */
export const CLAUDE_CONFIG_DIR = '/state/claude';
/** The same for a Codex runner (`CODEX_HOME`): `/state/codex/auth.json` is its sign-in file. */
export const CODEX_HOME_DIR = '/state/codex';
/** The file the Codex CLI keeps next to `auth.json` while it renews the tokens; the keeper does not copy anything while it exists. */
export const CODEX_LOCK_FILE = `${CODEX_HOME_DIR}/auth.lock`;

/**
 * A runner as the controller sees it: the catalog's row plus the tool its pod runs. A runner of kind `claude_cli` has no `agent` (or `claude`), a `codex_cli` runner has `codex`.
 * Everything that differs between the two lives in AGENTS below; nothing else in this file asks which tool it is.
 */
export type PodRunner = PodRunnerInfo & { agent?: PodAgent };

export interface AgentSpec {
  /** The start of every object name: `claude-<runner>`, `codex-<runner>`. */
  prefix: string;
  /** The sign-in file's name, and the key it has in the sign-in Secret. */
  file: string;
  /** The folder of the state volume that holds the sign-in file (the keeper mounts only this folder). */
  dir: string;
  /** The variable that tells the tool where its sign-in file is. */
  homeVar: string;
  /** The `agent` of a bridge profile. */
  profileAgent: 'claude-code' | 'codex';
  /** The ACP adapter the bridge starts for this agent (the agent pod image has it on PATH). */
  acpCommand: string;
  /** Who is running, in the note every run gets. */
  title: string;
}

export const AGENTS: Record<PodAgent, AgentSpec> = {
  claude: { prefix: 'claude', file: '.credentials.json', dir: CLAUDE_CONFIG_DIR, homeVar: 'CLAUDE_CONFIG_DIR', profileAgent: 'claude-code', acpCommand: 'claude-agent-acp', title: 'a shared Claude Code runner' },
  codex: { prefix: 'codex', file: 'auth.json', dir: CODEX_HOME_DIR, homeVar: 'CODEX_HOME', profileAgent: 'codex', acpCommand: 'codex-acp', title: 'a shared Codex runner' },
};
export const agentOf = (runner: { agent?: PodAgent | undefined }): PodAgent => runner.agent ?? 'claude';

export interface Names {
  /** Which tool the pod runs; decides the prefix of every name below. */
  agent: PodAgent;
  /** The Deployment and the Service: `claude-<runner>` (`codex-<runner>` for a Codex runner). */
  base: string;
  state: string;
  work: string;
  key: string;
  /** The sign-in Secret (written by the upload route, P19-06; the controller only reads whether it exists). */
  credentials: string;
  /** The key of the sign-in file in that Secret: `.credentials.json` or `auth.json`. */
  file: string;
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

/**
 * The names of a runner's objects. A Claude runner's are `claude-<runner>…`, a Codex runner's `codex-<runner>…`, so a Claude and a Codex runner never share an object
 * (the two prefixes differ, whatever the runner names are).
 */
export function namesFor(runnerName: string, agent: PodAgent = 'claude'): Names {
  const spec = AGENTS[agent];
  const base = `${spec.prefix}-${slugForRunner(runnerName)}`;
  return { agent, base, state: `${base}-state`, work: `${base}-work`, key: `${base}-key`, credentials: `${base}-credentials`, file: spec.file, config: `${base}-config`, keeper: `${base}-keeper` };
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
export interface InstructionOptions {
  /** The pod runs the agent pod image over ACP: the shared repository of record, the pnpm store and the browser exist. */
  acp?: boolean;
  /** The path of this bot's kubeconfig (the deployer bot of a one-team pod). */
  kubeconfig?: string | null;
  /** Codex runs commands without asking in this pod (the runner's full-access switch). */
  fullAccess?: boolean;
}

export function instructionsFor(teamSlug: string, botSlug: string, mayPublish = false, agent: PodAgent = 'claude', extra: InstructionOptions = {}): string {
  return [
    `You run on ${AGENTS[agent].title}, not on a person's machine. Your working folder is /work/${teamSlug}/${botSlug}.`,
    'The team projects are cloned next to it, in the folder /work/<team>/<bot>/<project>; work inside your own folder only.',
    'Do not read, copy or print anything under /state, /etc/bridge or the environment: they hold the runner\'s sign-in and keys, which are not yours to use.',
    'Post your answer and reports with the manythreads tools, not by writing files for people to find.',
    ...(agent === 'claude'
      ? ['For git, use `mt-git` in place of `git`: `mt-git status`, `diff`, `log`, `show`, `rev-parse`, `add`, `commit -m "<text>"`, `switch`, `checkout -b <branch>` and `branch --show-current`, inside the project folder. Plain `git` is not available to you, and `mt-git` refuses any other command or option.']
      : []),
    ...(extra.acp === true
      ? [
          `Each project also has a shared repository of record at /work/${teamSlug}/repos/<project>.git, which every bot of this pod can reach. Share a branch with the others with \`mt-git record-push <branch>\` (never main) and bring theirs in with \`mt-git record-fetch\`: their branches appear as refs/record/<branch> (start your own from one with \`mt-git checkout -b <branch> refs/record/<branch>\`).`,
          `Install packages with \`pnpm install --frozen-lockfile\`; the pod keeps one package store for all clones. A browser (Chromium) is installed for Playwright checks. There is no database in this pod, so run only tests that need none.`,
        ]
      : []),
    ...(extra.fullAccess === true ? ['Your commands run without a question in this pod (the pod is the sandbox): the pod reaches the platform and the internet on port 443 and no other address in the cluster. Still keep to your own folders, and never touch /state, /etc/bridge or the environment.'] : []),
    ...(typeof extra.kubeconfig === 'string' ? [`You are this team's deployer: \`kubectl\` and \`helm\` already use your kubeconfig (${extra.kubeconfig}), which can change the team's test namespace and nothing else. Do not print the file.`] : []),
    ...(mayPublish
      ? [
          'To hand your work in, commit it on a branch named card-<the first 8 characters of the card id>, then run `mt-publish publish <project> <card id> <the commit> "<title>"` (the pull request or merge request text on standard input). When the card says whose name the commit carries (an author name and email), add them as the last two arguments, exactly as given.',
          'It makes one commit of the whole change, pushes that branch and opens the pull request (merge request on GitLab). You never hold the push token and never push to the main branch yourself.',
        ]
      : []),
  ].join('\n');
}

/**
 * Git commands every bot may run without a question (decision E5, hardened in the P19-09 security review): enough to look, commit on a branch of its own and nothing that
 * reaches the network or rewrites history. They are `mt-git <subcommand>` and never plain `git`: a pre-approved `git diff:*` also allowed `git diff --no-index <any file> /dev/null`
 * (reads the shared sign-in under /state), `git log --output=<path>` (overwrites a file), `git add --pathspec-from-file` (leaks a file in its error text) and, with a hook or
 * a `core.fsmonitor` line written into `.git`, any command. `mt-git` (deploy/images/agent-pod/mt-git.mjs) accepts a fixed list of subcommands and options, keeps to the
 * project folder, refuses a repository config that could start a program and runs git with a clean environment.
 */
export const GIT_WRAPPER = 'mt-git';
export const GIT_TOOLS: readonly string[] = [
  `Bash(${GIT_WRAPPER} status:*)`,
  `Bash(${GIT_WRAPPER} diff:*)`,
  `Bash(${GIT_WRAPPER} log:*)`,
  `Bash(${GIT_WRAPPER} show:*)`,
  `Bash(${GIT_WRAPPER} rev-parse:*)`,
  `Bash(${GIT_WRAPPER} add:*)`,
  `Bash(${GIT_WRAPPER} commit:*)`,
  `Bash(${GIT_WRAPPER} switch:*)`,
  `Bash(${GIT_WRAPPER} checkout -b:*)`,
  `Bash(${GIT_WRAPPER} branch --show-current)`,
];
/** The two commands that move a branch between the bots of a pod through the team's repository of record (mt-git.mjs). */
export const RECORD_TOOLS: readonly string[] = [`Bash(${GIT_WRAPPER} record-push:*)`, `Bash(${GIT_WRAPPER} record-fetch)`];
/** The one extra command of a bot whose definition grants `tasks.pull_request`: the client of the pod's publisher. */
export const PUBLISH_TOOL = 'Bash(mt-publish:*)';

/** The pod has a publisher container: it is turned on and the platform's address is known. */
export const publisherOn = (cfg: ClaudePodConfig): boolean => cfg.publisher.enabled && cfg.serverUrl !== '';

/** `team slug` + `bot slug` of the bots whose definition grants `tasks.pull_request`, as one key per bot. */
export const publisherKey = (teamSlug: string, botSlug: string): string => `${teamSlug}/${botSlug}`;

/** Which bots of the pod are the team's deployer, and the Secret each team's kubeconfig comes from. Both empty: no kubeconfig anywhere in the pod. */
export interface DeployPlan {
  /** `team slug/bot slug` of the bots that hold the deployer login. */
  bots: ReadonlySet<string>;
  mounts: readonly { teamSlug: string; secret: string; key: string }[];
}
const NO_DEPLOY: DeployPlan = { bots: new Set(), mounts: [] };

/** Where a team's kubeconfig lies in the run container. */
export const kubeconfigPath = (teamSlug: string, key: string): string => `${DEPLOY_ROOT}/${teamSlug}/${key}`;

export function buildBridgeConfig(cfg: ClaudePodConfig, runner: PodRunner, publishers: ReadonlySet<string> = new Set(), deploy: DeployPlan = NO_DEPLOY): string {
  const profiles: Record<string, unknown> = {};
  const publishing = publisherOn(cfg);
  const agent = agentOf(runner);
  const spec = AGENTS[agent];
  const acp = cfg.driver === 'acp';
  // Full access is for a pod of one team (the route that sets it checks the same): a pod that serves two teams never runs without a question, whatever the column says.
  const fullAccess = acp && agent === 'codex' && runner.fullAccess === true && new Set(runner.bots.map((b) => b.teamId)).size <= 1;
  // A runner with no bot yet still needs one profile: the bridge's sign-in works on the profile of an agent, and an admin signs in before any bot is placed.
  const bots = runner.bots.length > 0 ? runner.bots : [{ teamId: '', teamSlug: 'default', botSlug: 'default' }];
  for (const b of bots) {
    const key = publisherKey(b.teamSlug, b.botSlug);
    const mayPublish = publishing && publishers.has(key);
    const mount = deploy.bots.has(key) ? deploy.mounts.find((m) => m.teamSlug === b.teamSlug) : undefined;
    const kubeconfig = mount ? kubeconfigPath(b.teamSlug, mount.key) : null;
    const where = runner.bots.length > 0 ? `/work/${b.teamSlug}/${b.botSlug}` : '/work';
    // the adapter and the sign-in folder (the Runners page signs the agent in and out through the bridge); the stand-in image has neither
    const driven = acp ? { driver: 'acp', acp: { command: spec.acpCommand }, authHome: spec.dir } : {};
    const tools = acp ? { npm_config_store_dir: PNPM_STORE, PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' } : {};
    const kube = kubeconfig !== null ? { KUBECONFIG: kubeconfig } : {};
    profiles[runner.bots.length > 0 ? profileName(b.teamSlug, b.botSlug) : 'default'] =
      agent === 'codex'
        ? {
            agent: 'codex',
            ...driven,
            workdir: where,
            modelAliases: cfg.codexModelAliases,
            // The runner's switch (admin, one team): the bridge also needs the run not to say no. The bridge's other key, "allowed", is for a server and is never written here.
            ...(fullAccess ? { fullAccess: true } : {}),
            // No `extraAllowedTools`: that list is Claude Code's. Codex runs with its own sandbox and approval policy, set by the bridge's driver.
            env: { CODEX_HOME: CODEX_HOME_DIR, HOME: '/state/home', ...tools, ...kube },
            instructions: instructionsFor(b.teamSlug, b.botSlug, mayPublish, 'codex', { acp, kubeconfig, fullAccess }),
          }
        : {
            agent: 'claude-code',
            ...driven,
            workdir: where,
            modelAliases: cfg.modelAliases,
            extraAllowedTools: [...GIT_TOOLS, ...(acp ? RECORD_TOOLS : []), ...(mayPublish ? [PUBLISH_TOOL] : [])],
            env: { CLAUDE_CONFIG_DIR, HOME: '/state/home', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...tools, ...kube },
            instructions: instructionsFor(b.teamSlug, b.botSlug, mayPublish, 'claude', { acp, kubeconfig }),
          };
  }
  return JSON.stringify({ profiles, maxConcurrentRuns: runner.maxConcurrent ?? cfg.defaultConcurrency }, null, 2);
}

/** One entry per clone the runner's bots need: the platform's list of projects, per bot of the team. Sent to the bridge as JSON and written into the ConfigMap as lines. */
export function reposFor(runner: PodRunner, repos: readonly RepoToSync[]): { team: string; bot: string; project: string; branch: string | null; origin: string }[] {
  return runner.bots.flatMap((b) => repos.filter((r) => r.teamSlug === b.teamSlug).map((r) => ({ team: b.teamSlug, bot: b.botSlug, project: r.name, branch: r.branch ?? null, origin: r.origin })));
}

export function buildConfigMap(cfg: ClaudePodConfig, runner: PodRunner, names: Names, repos: readonly RepoToSync[], publishers: ReadonlySet<string> = new Set(), deploy: DeployPlan = NO_DEPLOY): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: names.config, namespace: cfg.namespace, labels: labelsFor(runner) },
    data: {
      'config.json': buildBridgeConfig(cfg, runner, publishers, deploy),
      // one line per clone for the sync step: <team> <bot> <project> <branch or -> <https address>
      'repos.txt': reposFor(runner, repos).map((r) => `${r.team} ${r.bot} ${r.project} ${r.branch ?? '-'} ${r.origin}`).join('\n') + '\n',
    },
  };
}

export function buildKeySecret(cfg: ClaudePodConfig, runner: PodRunner, names: Names, apiKey: string): K8sObject {
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
  /**
   * The pod holds a sign-in Secret (an upload, the old way): the keeper, its ServiceAccount and the mount of the Secret exist only then. A runner signed in through the Runners page
   * keeps its sign-in in the state volume and has no keeper. Absent: true (the old shape).
   */
  keeper?: boolean;
  /** The kubeconfig Secrets mounted in the run container (one team's deployer; see `deployPlanFor`). Empty or absent: none. */
  deployMounts?: readonly { teamSlug: string; secret: string; key: string }[];
  /** A hash of the bridge's profiles (config.json). The bridge reads them once at start, so a changed set rolls the pod; the repository list is not part of it. */
  profilesSha?: string | null;
}

/** The Secret of a team's push tokens made by the Hermes pods' controller (`hermes-<team>-push`, one key per project): the same name rule as there, so the two pod kinds read one Secret. */
export function pushSecretName(team: { id: string; slug: string }, disambiguate = false): string {
  const slug = team.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
  return disambiguate ? `hermes-${slug.slice(0, 30)}-${team.id.replace(/-/g, '').slice(0, 8)}-push` : `hermes-${slug}-push`;
}

const NO_PRIVILEGE = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } } as const;

export function buildDeployment(cfg: ClaudePodConfig, runner: PodRunner, names: Names, opts: DeploymentOptions): K8sObject {
  const spec = AGENTS[names.agent];
  const codex = names.agent === 'codex';
  const keeper = opts.keeper !== false;
  const deployMounts = [...(opts.deployMounts ?? [])].sort((a, b) => a.teamSlug.localeCompare(b.teamSlug));
  // The pod may reach the Kubernetes API (the chart's second policy): only the keeper's pod and the deployer's pod.
  const podLabels = labelsFor(runner, { 'manythreads.io/pod': names.base, ...(keeper || deployMounts.length > 0 ? { [KUBE_API_LABEL]: 'true' } : {}) });
  const acp = cfg.driver === 'acp';
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
          ...(keeper ? { serviceAccountName: names.keeper } : {}),
          // gVisor (or another sandbox runtime) when the chart names one (claudePod.runtimeClassName, decision E22); the same for a Claude and a Codex pod
          ...(cfg.runtimeClassName !== undefined && cfg.runtimeClassName !== '' ? { runtimeClassName: cfg.runtimeClassName } : {}),
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
                `install -d -o 1000 -g 1000 -m 0700 ${spec.dir} /state/home /state/bridge && install -d -o 1000 -g 1000 -m 0755 /work${acp ? ` ${PNPM_STORE}` : ''}` +
                  (keeper
                    ? // the file is copied when the volume has none, or when the Secret holds a newer upload (its upload-id differs from the one the volume last took)
                      ` && if [ -f /creds/${spec.file} ] && { [ ! -f ${spec.dir}/${spec.file} ] || [ "$(cat /creds/upload-id 2>/dev/null)" != "$(cat ${spec.dir}/.upload-id 2>/dev/null)" ]; }; then` +
                      ` install -o 1000 -g 1000 -m 0600 /creds/${spec.file} ${spec.dir}/${spec.file} && install -o 1000 -g 1000 -m 0600 /creds/upload-id ${spec.dir}/.upload-id; fi`
                    : ''),
              ],
              securityContext: { runAsNonRoot: false, runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] }, seccompProfile: { type: 'RuntimeDefault' } },
              resources: { limits: { memory: '64Mi' } },
              volumeMounts: [
                { name: 'state', mountPath: '/state' },
                { name: 'work', mountPath: '/work' },
                ...(keeper ? [{ name: 'creds', mountPath: '/creds', readOnly: true }] : []),
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
                { name: spec.homeVar, value: spec.dir },
                // A Codex process in a pod loses OPENAI_API_KEY (an API key would go around the platform's model gateway): the bridge reads this switch.
                ...(codex ? [{ name: 'MANYTHREADS_BRIDGE_IN_POD', value: '1' }] : []),
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
                // a browser needs more shared memory than a container gets by default
                ...(acp ? [{ name: 'dshm', mountPath: '/dev/shm' }] : []),
                { name: 'config', mountPath: '/etc/bridge', readOnly: true },
                // the controller's repository list lands here (the bridge writes it, the repo-sync container reads it)
                { name: 'repos', mountPath: '/run/repos' },
                // the socket the `mt-publish` command talks to; the publisher container owns the other end. No token, no Secret and no push folder is mounted in this container.
                ...(publishing ? [{ name: 'publish', mountPath: PUBLISH_DIR }] : []),
                // the deployer's kubeconfig (a pod of one team): readable by every bot of the pod, because they all run as one user; only the deployer's profile names it in KUBECONFIG
                ...deployMounts.map((d, i) => ({ name: `deployer-${i}`, mountPath: `${DEPLOY_ROOT}/${d.teamSlug}`, readOnly: true })),
              ],
            },
            ...(keeper
              ? [
            {
              // Copies a renewed sign-in file back into its Secret (keeper.mjs). Reads the sign-in folder read-only; has the one Kubernetes token in the pod.
              name: 'keeper',
              image: cfg.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['node', '/opt/claude-pod/keeper.mjs'],
              env: [
                { name: 'KEEPER_NAMESPACE', value: cfg.namespace },
                { name: 'KEEPER_SECRET', value: names.credentials },
                // The keeper's defaults are the Claude runner's; a Codex runner names its own file, the Secret's key for it, and the lock file it waits for.
                ...(codex ? [{ name: 'KEEPER_KIND', value: 'codex' }, { name: 'KEEPER_FILE', value: `${spec.dir}/${spec.file}` }, { name: 'KEEPER_KEY', value: spec.file }, { name: 'KEEPER_LOCK', value: CODEX_LOCK_FILE }] : []),
              ],
              securityContext: { ...NO_PRIVILEGE, readOnlyRootFilesystem: true },
              resources: { requests: { cpu: '5m', memory: '24Mi' }, limits: { memory: '96Mi' } },
              volumeMounts: [
                { name: 'state', mountPath: spec.dir, subPath: spec.dir.replace('/state/', ''), readOnly: true },
                { name: 'keeper-token', mountPath: '/var/run/secrets/keeper', readOnly: true },
              ],
            },
              ]
              : []),
            {
              // Clones and fetches the projects of the teams on the list into /work. It has no Kubernetes token and no access to the sign-in folder.
              name: 'repo-sync',
              image: cfg.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '/opt/claude-pod/repo-sync.sh'],
              env: [
                { name: 'HOME', value: '/tmp' },
                { name: 'REPO_SYNC_SCRATCH', value: REPO_SYNC_SCRATCH },
              ],
              securityContext: { ...NO_PRIVILEGE, readOnlyRootFilesystem: true },
              resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '256Mi' } },
              volumeMounts: [
                { name: 'work', mountPath: '/work' },
                { name: 'tmp', mountPath: '/tmp' },
                // the one place this container writes that the bot's container cannot: /work and /tmp are shared with the bot, which writes them as the same user, so a git config
                // or a state file kept there could be changed under the script's feet (repo-sync.sh makes its private git folder here)
                { name: 'repo-sync-scratch', mountPath: REPO_SYNC_SCRATCH },
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
            { name: 'tmp', emptyDir: { sizeLimit: acp ? '2Gi' : '512Mi' } },
            { name: 'config', configMap: { name: names.config } },
            { name: 'repos', emptyDir: { sizeLimit: '8Mi' } },
            { name: 'repo-sync-scratch', emptyDir: { medium: 'Memory', sizeLimit: '4Mi' } },
            ...(publishing
              ? [
                  { name: 'publish', emptyDir: { sizeLimit: '1Mi' } },
                  // the publisher's scratch space (a private copy of one token file per request, removed at the end); memory, so no token reaches a disk
                  { name: 'publisher-tmp', emptyDir: { medium: 'Memory', sizeLimit: '32Mi' } },
                  // optional: the Secret exists only once a lead has saved a token for a project of the team. Files are readable by the publisher's user; no other container mounts them.
                  ...pushSecrets.map((p, i) => ({ name: `push-${i}`, secret: { secretName: p.secret, defaultMode: 0o444, optional: true } })),
                ]
              : []),
            ...(acp ? [{ name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: cfg.shmSize } }] : []),
            ...deployMounts.map((d, i) => ({ name: `deployer-${i}`, secret: { secretName: d.secret, defaultMode: 0o444, optional: true } })),
            ...(keeper
              ? [
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
                ]
              : []),
          ],
        },
      },
    },
  };
}
