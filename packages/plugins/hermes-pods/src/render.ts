import { createHash } from 'node:crypto';
import type { GatewayProfileSpec } from '@manythreads/sdk';
import { isRepoOriginAllowed } from '@manythreads/shared';
import type { K8sObject } from './k8s.ts';

// Pure builders: the Kubernetes objects of one team's pod, from plain values. No network, no clock, no randomness (the one
// generated secret, the pod's own gateway key, is drawn by the caller and passed in), so every object can be asserted in a test.

export interface PodConfig {
  /** Namespace the pods live in (the server's own). */
  namespace: string;
  hermesImage: string;
  workbenchImage: string;
  workspaceSize: string;
  homeSize: string;
  storageClass: string;
  repos: { name: string; origin?: string; branch?: string }[];
  /** https:// prefixes a repository may be cloned from; empty = none. */
  repoOriginAllow: string[];
  /** Bot slug that receives the deployer credential ('' = none). */
  deployerBot: string;
  /** A team's apps live in the namespace `<appsPrefix><team slug>`; each has its own deployer ServiceAccount (the chart makes them). */
  appsPrefix: string;
  /** How apps are reached: `path` = https://<appsHost>/apps/<team>/<app>/ (the platform's own host); `host` = https://<app>--<team>.<appsHost>/. */
  appsRouting: AppsRouting;
  appsHost: string;
  resources: { hermes: Resources; workbench: Resources };
  /** Extra namespaces a team's deployer may administer (the chart's `hermesPods.deployTargets`; docs/deploy-preview.md). Absent or empty = none. */
  deployTargets?: DeployTarget[];
  /**
   * The Kubernetes API address as the HOST reaches it (k3s: `https://127.0.0.1:6443`), for a deployer bot that runs outside the cluster through the
   * agent bridge, where `kubernetes.default.svc` does not resolve. Set = the deployer Secret also holds `deployer.host.kubeconfig`, the same login
   * with this address. Empty or absent = only the in-cluster file.
   */
  hostApiServer?: string;
}

/** A namespace where one team's deployer bot has full control of what runs in it (a preview install of the platform). */
export interface DeployTarget {
  team: string;
  namespace: string;
  hosts: string[];
}

export type AppsRouting = 'path' | 'host';

export interface Resources {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

export interface Team {
  id: string;
  slug: string;
}

export const GATEWAY_PORT = 8642;
export const SSH_PORT = 2222;
/** First Unix uid handed to a bot (below it: the system accounts of the image). */
export const FIRST_BOT_UID = 20000;

export interface Names {
  base: string;
  profiles: string;
  key: string;
  deployer: string;
  bots: string;
  workspace: string;
  home: string;
}

/** The team's slug as it appears in names: lowercase letters, digits and dashes, at most 40 characters. */
export function slugForName(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team';
}

/** The public address of a team's app, in the form this install's routing gives it (the chart's admission policy enforces the same shapes). */
export function appUrlFor(cfg: { appsRouting: AppsRouting; appsHost: string }, team: Team, app: string): string {
  const t = slugForName(team.slug);
  return cfg.appsRouting === 'host' ? `https://${app}--${t}.${cfg.appsHost}/` : `https://${cfg.appsHost}/apps/${t}/${app}/`;
}

/** The address pattern to tell the deployer bot, with `<app>` left for it to fill in. */
export function appUrlPattern(cfg: { appsRouting: AppsRouting; appsHost: string }, team: Team): string {
  return appUrlFor(cfg, team, '<app>');
}

/** The namespace of a team's deployed apps. */
export function appsNamespaceFor(cfg: { appsPrefix: string }, team: Team): string {
  return `${cfg.appsPrefix}${slugForName(team.slug)}`;
}

/** `hermes-<slug>`, a valid DNS label (the Service name is the gateway's address: `http://hermes-engineering:8642`). */
export function namesFor(team: Team, disambiguate = false): Names {
  const slug = slugForName(team.slug);
  const base = disambiguate ? `hermes-${slug.slice(0, 30)}-${team.id.replace(/-/g, '').slice(0, 8)}` : `hermes-${slug}`;
  return {
    base,
    profiles: `${base}-profiles`,
    key: `${base}-key`,
    deployer: `${base}-deployer`,
    bots: `${base}-bots`,
    workspace: `${base}-workspace`,
    home: `${base}-home`,
  };
}

export function labelsFor(team: Team, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'manythreads',
    'app.kubernetes.io/component': 'hermes-pod',
    'app.kubernetes.io/managed-by': 'manythreads-hermes-pods',
    'manythreads.io/team-id': team.id,
    'manythreads.io/team': team.slug.replace(/[^a-z0-9-]/g, '-').slice(0, 60),
    ...extra,
  };
}

/** Profile name `mt-<bot slug>` -> the bot's slug. */
export function botSlugOf(profile: string): string {
  return profile.startsWith('mt-') ? profile.slice(3) : profile;
}

/** The Unix user of a bot in the workbench: `bot-<slug>`, lowercase letters, digits and dashes, at most 31 characters. */
export function unixUserFor(botSlug: string): string {
  const clean = botSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const name = `bot-${clean || 'x'}`;
  if (name.length <= 31) return name;
  const hash = createHash('sha256').update(botSlug).digest('hex').slice(0, 6);
  return `${name.slice(0, 24).replace(/-+$/, '')}-${hash}`;
}

export interface BotUser {
  user: string;
  uid: number;
  deployer: boolean;
  profile: string;
}

/** Assigns each profile a stable uid: the ones already in the pod's ConfigMap keep theirs, new ones take the next free number. */
export function assignUsers(profiles: readonly GatewayProfileSpec[], existing: Readonly<Record<string, number>>, deployerBot: string): BotUser[] {
  const taken = new Set(Object.values(existing));
  let next = FIRST_BOT_UID;
  const out: BotUser[] = [];
  const seen = new Set<string>();
  for (const spec of [...profiles].sort((a, b) => a.profile.localeCompare(b.profile))) {
    const user = unixUserFor(botSlugOf(spec.profile));
    if (seen.has(user)) continue;
    seen.add(user);
    let uid = existing[user];
    if (uid === undefined) {
      while (taken.has(next)) next++;
      uid = next;
      taken.add(uid);
    }
    out.push({ user, uid, deployer: deployerBot !== '' && botSlugOf(spec.profile) === deployerBot, profile: spec.profile });
  }
  return out;
}

export function parseRepos(spec: string): { name: string; origin?: string }[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const eq = s.indexOf('=');
      return eq < 0 ? { name: s } : { name: s.slice(0, eq), origin: s.slice(eq + 1) };
    })
    .filter((r) => /^[a-z0-9][a-z0-9._-]{0,60}$/.test(r.name) && !r.name.includes('..'));
}

// objects ---------------------------------------------------------------------------------------------------------------------

export function buildBotsConfigMap(cfg: PodConfig, team: Team, names: Names, users: readonly BotUser[]): K8sObject {
  const doc = {
    bots: users.map((u) => ({ user: u.user, uid: u.uid, deployer: u.deployer })),
    repos: cfg.repos.filter((r) => !r.origin || isRepoOriginAllowed(r.origin, cfg.repoOriginAllow)),
    originAllow: cfg.repoOriginAllow,
  };
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: names.bots, namespace: cfg.namespace, labels: labelsFor(team) },
    data: { 'bots.json': JSON.stringify(doc) },
  };
}

/** The profile Secret: one JSON document the Hermes container's sync turns into profile directories. Secrets are in it, so it is a Secret. */
export function buildProfilesSecret(cfg: PodConfig, team: Team, names: Names, profiles: readonly GatewayProfileSpec[], users: readonly BotUser[]): K8sObject {
  const byProfile = new Map(users.map((u) => [u.profile, u]));
  const doc = {
    profiles: profiles
      .filter((p) => byProfile.has(p.profile))
      .map((p) => {
        const u = byProfile.get(p.profile)!;
        // `.env.template` documents the secrets' names; the real `.env` is written by the sync from `secrets`
        const files = Object.fromEntries(Object.entries(p.files).filter(([name]) => name !== '.env.template'));
        return { profile: p.profile, user: u.user, cwd: `/workspace/bots/${u.user}`, files, secrets: p.secrets };
      }),
  };
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: names.profiles, namespace: cfg.namespace, labels: labelsFor(team) },
    type: 'Opaque',
    stringData: { 'profiles.json': JSON.stringify(doc) },
  };
}

export function buildKeySecret(cfg: PodConfig, team: Team, names: Names, apiKey: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: names.key, namespace: cfg.namespace, labels: labelsFor(team) },
    type: 'Opaque',
    stringData: { 'api-key': apiKey },
  };
}

/** A kubeconfig that signs in as the `deployer` ServiceAccount of the apps namespace and does nothing else (`token` is that account's own). */
export function buildDeployerKubeconfig(input: {
  /** The apps namespace's deployer token; null when the team has no apps namespace (then only its deploy targets are in the file). */
  token: string | null;
  caPem: string;
  appsNamespace: string;
  server?: string;
  appUrlPattern?: string;
  appsRouting?: AppsRouting;
  /** One more context per deploy target of the team: named after the namespace, signed in as that namespace's own `deployer` account. */
  targets?: DeployTargetLogin[];
}): string {
  const server = input.server ?? 'https://kubernetes.default.svc';
  const j = (v: string): string => JSON.stringify(v);
  // Comments at the top tell the deployer bot, which reads this file, how its apps are reached and what an Ingress must look like.
  const apps = input.token !== null;
  const targets = input.targets ?? [];
  const guide = apps && input.appUrlPattern
    ? input.appsRouting === 'host'
      ? [
          `# Apps are reached at ${input.appUrlPattern}: an Ingress with host "<app>--<team>.<domain>", no tls section needed.`,
        ]
      : [
          `# Apps are reached at ${input.appUrlPattern} (this exact public address, on the platform's own host).`,
          '# The Ingress must have: host = the platform host, path /apps/<team>/<app> with pathType Prefix, and exactly the annotation',
          `#   traefik.ingress.kubernetes.io/router.middlewares: ${input.appsNamespace}-apps-path@kubernetescrd`,
          '# and no tls section. The app receives paths with /apps/<team>/<app> removed (it is sent as X-Forwarded-Prefix); it never sees the platform\'s',
          '# cookies, runs in a sandbox (no cookies, no localStorage), and must use relative URLs and allow cross-origin requests (CORS) to itself.',
        ]
    : [];
  return [
    ...guide,
    ...targetGuide(targets, apps),
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    `  - name: cluster`,
    '    cluster:',
    `      server: ${j(server)}`,
    `      certificate-authority-data: ${j(Buffer.from(input.caPem).toString('base64'))}`,
    'users:',
    ...(apps ? ['  - name: deployer', '    user:', `      token: ${j(input.token!)}`] : []),
    ...targetUsers(targets),
    'contexts:',
    ...(apps ? ['  - name: deployer', '    context:', '      cluster: cluster', '      user: deployer', `      namespace: ${j(input.appsNamespace)}`] : []),
    ...targetContexts(targets),
    // Without an apps namespace the first deploy target is the default context.
    `current-context: ${apps ? 'deployer' : j(targets[0]?.namespace ?? 'deployer')}`,
    '',
  ].join('\n');
}

/** A deploy target the deployer can sign in to: its namespace, the hosts its Ingress may name, and the token of that namespace's `deployer` account. */
export interface DeployTargetLogin {
  namespace: string;
  hosts: string[];
  token: string;
  /** The cluster's CA, as that namespace's token Secret carries it (used when the team has no apps namespace to take it from). */
  caPem?: string;
}

// The extra kubeconfig lines for deploy targets. Kept apart from the apps context above: the current context never changes.
function targetUsers(targets: readonly DeployTargetLogin[]): string[] {
  return targets.flatMap((t) => ['  - name: ' + JSON.stringify(`deployer-${t.namespace}`), '    user:', `      token: ${JSON.stringify(t.token)}`]);
}

function targetContexts(targets: readonly DeployTargetLogin[]): string[] {
  return targets.flatMap((t) => [
    `  - name: ${JSON.stringify(t.namespace)}`,
    '    context:',
    '      cluster: cluster',
    `      user: ${JSON.stringify(`deployer-${t.namespace}`)}`,
    `      namespace: ${JSON.stringify(t.namespace)}`,
  ]);
}

/** The comment lines that tell the deployer bot which extra contexts exist (it reads its kubeconfig). */
function targetGuide(targets: readonly DeployTargetLogin[], apps: boolean): string[] {
  if (targets.length === 0) return [];
  return [
    apps
      ? '# Deploy targets: whole namespaces you administer (use `kubectl --context <namespace> ...`; the default context above is unchanged).'
      : '# Deploy targets: whole namespaces you administer (`kubectl --context <namespace> ...`; the first one is the default context).',
    ...targets.map((t) => `#   ${t.namespace}: Ingress hosts allowed: ${t.hosts.join(', ') || '(none)'}. Build and install recipe: deploy/preview/README.md in the manythreads repository.`),
  ];
}

export function buildDeployerSecret(cfg: PodConfig, team: Team, names: Names, kubeconfig: string, hostKubeconfig?: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: names.deployer, namespace: cfg.namespace, labels: labelsFor(team) },
    type: 'Opaque',
    stringData: { 'deployer.kubeconfig': kubeconfig, ...(hostKubeconfig !== undefined ? { 'deployer.host.kubeconfig': hostKubeconfig } : {}) },
  };
}

/**
 * The deployer Secret for one login: the in-cluster kubeconfig, plus (when `cfg.hostApiServer` is set) a second file that differs only in the API
 * address, for a bot on the host. The CA stays the cluster's own (k3s's API certificate also names 127.0.0.1 and the node's IP).
 */
export function buildDeployerSecretFor(cfg: PodConfig, team: Team, names: Names, login: Parameters<typeof buildDeployerKubeconfig>[0]): K8sObject {
  const host = (cfg.hostApiServer ?? '').trim();
  return buildDeployerSecret(cfg, team, names, buildDeployerKubeconfig(login), host !== '' ? buildDeployerKubeconfig({ ...login, server: host }) : undefined);
}

export function buildPvc(cfg: PodConfig, team: Team, name: string, size: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace: cfg.namespace, labels: labelsFor(team) },
    spec: { accessModes: ['ReadWriteOnce'], storageClassName: cfg.storageClass, resources: { requests: { storage: size } } },
  };
}

export function buildService(cfg: PodConfig, team: Team, names: Names): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: names.base, namespace: cfg.namespace, labels: labelsFor(team) },
    spec: {
      selector: { 'manythreads.io/pod': names.base },
      ports: [{ name: 'gateway', port: GATEWAY_PORT, targetPort: GATEWAY_PORT }],
    },
  };
}

export function buildDeployment(cfg: PodConfig, team: Team, names: Names, opts: { replicas: number; withDeployer: boolean }): K8sObject {
  const podLabels = labelsFor(team, { 'manythreads.io/pod': names.base });
  const ro = (name: string, mountPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, mountPath, readOnly: true, ...extra });
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: names.base, namespace: cfg.namespace, labels: labelsFor(team) },
    spec: {
      replicas: opts.replicas,
      // both volumes are ReadWriteOnce: the old pod lets go of them before the new one starts
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'manythreads.io/pod': names.base } },
      template: {
        metadata: { labels: podLabels },
        spec: {
          // no ServiceAccount token in the pod: neither Hermes nor a bot can talk to the Kubernetes API with the pod's identity
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 30,
          initContainers: [
            {
              // The kubelet creates a volume's sub-directories owned by root; Hermes runs as uid 1000 and must write them.
              name: 'prepare-home',
              image: cfg.workbenchImage,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', 'install -d -o 1000 -g 1000 -m 0755 /home-volume/profiles && install -d -o 1000 -g 1000 -m 0700 /home-volume/ssh'],
              securityContext: { runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'] }, seccompProfile: { type: 'RuntimeDefault' } },
              volumeMounts: [{ name: 'home', mountPath: '/home-volume' }],
            },
          ],
          containers: [
            {
              name: 'hermes',
              image: cfg.hermesImage,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ name: 'gateway', containerPort: GATEWAY_PORT }],
              env: [
                { name: 'API_SERVER_ENABLED', value: 'true' },
                { name: 'API_SERVER_HOST', value: '0.0.0.0' },
                { name: 'API_SERVER_PORT', value: String(GATEWAY_PORT) },
                { name: 'API_SERVER_KEY', valueFrom: { secretKeyRef: { name: names.key, key: 'api-key' } } },
                { name: 'WORKBENCH_HOST', value: '127.0.0.1' },
                { name: 'WORKBENCH_PORT', value: String(SSH_PORT) },
              ],
              securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
              readinessProbe: { httpGet: { path: '/health', port: GATEWAY_PORT }, initialDelaySeconds: 10, periodSeconds: 5, failureThreshold: 12 },
              livenessProbe: { httpGet: { path: '/health', port: GATEWAY_PORT }, initialDelaySeconds: 120, periodSeconds: 20, failureThreshold: 6 },
              resources: cfg.resources.hermes,
              volumeMounts: [
                ro('profiles-in', '/in'),
                { name: 'home', mountPath: '/home/node/.hermes/profiles', subPath: 'profiles' },
                { name: 'home', mountPath: '/home/node/.ssh', subPath: 'ssh' },
                { name: 'keys', mountPath: '/keys' },
              ],
            },
            {
              name: 'workbench',
              image: cfg.workbenchImage,
              imagePullPolicy: 'IfNotPresent',
              // root inside the container (sshd and useradd need it); everything a bot does runs as that bot's own Unix user.
              securityContext: {
                runAsUser: 0,
                allowPrivilegeEscalation: true, // sudo, for the two fixed commands bots may run as the repo user
                capabilities: { drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETUID', 'SETGID', 'SYS_CHROOT', 'AUDIT_WRITE'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              readinessProbe: { exec: { command: ['pgrep', '-x', 'sshd'] }, periodSeconds: 5 },
              resources: cfg.resources.workbench,
              volumeMounts: [
                { name: 'workspace', mountPath: '/workspace' },
                ro('bots-config', '/etc/workbench'),
                ...(opts.withDeployer ? [ro('deployer', '/etc/workbench-secret')] : []),
                ro('keys', '/keys'),
                { name: 'shm', mountPath: '/dev/shm' },
              ],
            },
          ],
          volumes: [
            // world-readable inside the pod is fine: only the Hermes container mounts it (a pod-wide fsGroup would re-own the whole workspace volume)
            { name: 'profiles-in', secret: { secretName: names.profiles, defaultMode: 0o444 } },
            { name: 'home', persistentVolumeClaim: { claimName: names.home } },
            { name: 'workspace', persistentVolumeClaim: { claimName: names.workspace } },
            { name: 'bots-config', configMap: { name: names.bots } },
            ...(opts.withDeployer ? [{ name: 'deployer', secret: { secretName: names.deployer, defaultMode: 0o400 } }] : []),
            { name: 'keys', emptyDir: { sizeLimit: '1Mi' } },
            { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
          ],
        },
      },
    },
  };
}
