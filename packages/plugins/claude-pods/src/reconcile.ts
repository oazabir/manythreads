import { createHash, randomBytes } from 'node:crypto';
import type { ClaudePodPlacement, PluginLogger, PodRunnerState } from '@manythreads/sdk';
import {
  confirmedFor,
  isNodeLabelValue,
  isTerminating,
  MOVE_HELD_ANNOTATION,
  MOVING_ANNOTATION,
  needsNodeLookup,
  volumeSite,
  withProjectRepos,
  type K8s,
  type K8sObject,
  type ProjectRepo,
  type RepoConfig,
} from '@manythreads/sdk/pods';
import type { ClaudePodConfig } from './config.ts';
import {
  BRIDGE_PORT,
  AGENTS,
  buildBridgeConfig,
  buildConfigMap,
  buildDeployment,
  buildKeeperRbac,
  buildKeySecret,
  buildPvc,
  buildService,
  COMPONENT,
  MANAGED_BY,
  namesFor,
  PLACEHOLDER_TEAM,
  publisherKey,
  publisherOn,
  pushSecretName,
  reposFor,
  runnerForTeam,
  teamLabels,
  type DeployPlan,
  type PodTeam,
  type Names,
  type PodRunner,
  type RepoToSync,
} from './render.ts';

/** What the controller needs from the platform besides the runner list: the repositories the runner's teams ask for. Absent in a test that needs none. */
export interface RunnerSource {
  /** Every Claude Code and Codex runner; a Codex runner says so in `agent`. */
  runners(): Promise<PodRunner[]>;
  /** The teams' projects, as repositories of record. */
  reposForTeams?(teamIds: readonly string[]): Promise<(ProjectRepo & { teamSlug: string })[]>;
  /** The bots of these teams whose definition grants `tasks.pull_request`: only they are allowed the `mt-publish` command. Absent in a test that needs none. */
  publishersForTeams?(teamIds: readonly string[]): Promise<{ teamSlug: string; botSlug: string }[]>;
  /**
   * The team's deployer kubeconfig Secret (the `deploy.kubeconfig` provider of hermes-pods), or null when the team has none or the provider is not loaded. Only asked for a pod of one team
   * that has the deployer bot. Absent in a test that needs none.
   */
  deployerKubeconfig?(team: { id: string; slug: string }): Promise<{ secret: string; key: string } | null>;
  /** Tell the catalog how the pod is doing. */
  report?(state: PodRunnerState): Promise<void>;
}

/** One team's pod of a runner: the team, the pod's names (its work claim may be the runner's old one, see `podsOf`) and the runner as this team sees it (only this team's bots). */
interface TeamPod {
  team: PodTeam;
  names: Names;
  runner: PodRunner;
}

interface NodePlan {
  node: string | null;
  /** The machine the runner's volumes are on now (null: none known). With several pods and no machine chosen, the pods are pinned here so they can share the state volume. */
  site: string | null;

  stamp: Record<string, string | null>;
  moving: boolean;
  held: string | null;
  stale: string[];
}

export interface RunnerResult {
  runner: string;
  /** The runner's first team pod (its name); `pods` lists them all. */
  pod: string;
  pods: string[];
  /** The replicas of all the runner's team pods together. */
  replicas: number;
  node: string | null;
  moving: boolean;
  held: string | null;
  state: PodRunnerState['status'];
}

/**
 * The decision of what to report, from facts only: a pod is never "ready" before it holds a sign-in and has a running container. The sign-in is either an uploaded file
 * (`hasCredentials`: the old way) or one the bridge reports as signed in (`signedIn`: the Runners page signed the agent in inside the pod).
 */
export function stateFor(input: { hasCredentials: boolean; signedIn?: boolean; hasBots: boolean; enabled: boolean; moving: boolean; held: string | null; pending: boolean; unschedulable: boolean; running: boolean }): { status: PodRunnerState['status']; detail: string | null } {
  const signed = input.hasCredentials || input.signedIn === true;
  if (input.moving) return { status: 'moving', detail: 'Moving to the machine you chose. The work volume is being made again.' };
  if (!signed && !input.running) return { status: 'waiting_for_sign_in', detail: input.enabled ? 'Waiting for a sign-in. Choose Sign in on this runner once its pod is up.' : 'Waiting for a sign-in. This runner is off.' };
  if (input.held !== null) return { status: 'waiting_for_node', detail: 'The machine changed, but the move is not confirmed. The pod stays where its data is.' };
  if (input.pending && input.unschedulable) return { status: 'waiting_for_node', detail: 'Waiting for its machine: the pod cannot be placed there yet.' };
  if (input.running) return signed ? { status: 'ready', detail: null } : { status: 'waiting_for_sign_in', detail: 'Waiting for a sign-in. Choose Sign in on this runner.' };
  if (!input.enabled || !input.hasBots) return { status: 'starting', detail: input.enabled ? 'No bot is placed on this runner yet, so its pod is stopped.' : null };
  return { status: 'starting', detail: 'The pod is starting.' };
}

const b64 = (s: string | undefined): string => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

/** The label that names the runner an object belongs to (its id). An object that carries another runner's id is never touched. */
const RUNNER_ID = 'manythreads.io/runner-id';
const TEAM_ID = 'manythreads.io/team-id';
const phaseOf = (p: K8sObject): string => String((p.status as { phase?: string } | undefined)?.phase ?? '');

/**
 * Brings the Kubernetes objects of every Claude Code and Codex runner in line with the catalog. Safe to run repeatedly; it touches only objects it labelled itself.
 *
 * One runner is one pod PER TEAM (P26-21, agents-anywhere §9b). The runner is the sign-in: its `state` claim (the agent's home), sign-in Secret and keeper identity are shared by every team
 * pod. Each team pod has its own Deployment and Service (`claude-<runner>-<team>`), bridge key, bridge config (only that team's bots), work claim, repository list, push mount and deploy login.
 */
export class Reconciler {
  constructor(
    private readonly k8s: K8s,
    private readonly cfg: ClaudePodConfig,
    private readonly source: RunnerSource,
    private readonly log: PluginLogger,
    private readonly newKey: () => string = () => randomBytes(24).toString('hex'),
    private readonly now: () => number = Date.now,
    /** Test seams: the HTTP client the repository list is sent with, and the address of a pod's bridge. */
    private readonly doFetch: typeof fetch = fetch,
    private readonly bridgeUrl: (names: Names) => string = (names) => `http://${names.base}.${cfg.namespace}.svc:${BRIDGE_PORT}`,
  ) {}

  /** What the bridge of each team pod was last sent (a hash of the list), so an unchanged list is not sent again. A failed send is not recorded and is tried again. */
  private readonly sentRepos = new Map<string, string>();

  /**
   * The push Secret of a team's Hermes pod: the same one the Hermes pods' controller fills (`hermes-<team>-push`). A team whose plain name is taken by another team's pod
   * has the longer name, as there.
   */
  private async pushSecretOf(team: { id: string; slug: string }): Promise<string> {
    const plain = pushSecretName(team);
    const existing = await this.k8s.get('Deployment', this.cfg.namespace, plain.replace(/-push$/, ''));
    const owner = existing?.metadata.labels?.['manythreads.io/team-id'];
    return existing && owner !== undefined && owner !== team.id ? pushSecretName(team, true) : plain;
  }

  /**
   * Sends the repository list to a team pod's bridge (decision E4): the ConfigMap copy reaches a pod after about a minute, this reaches the repo-sync container in seconds.
   * `runner` is the runner as that team's pod sees it, so the list holds that team's repositories only. Returns whether the bridge took it. Any failure (the pod is not up yet, or
   * restarting) is logged in words and tried again on the next pass; the pod starts from the ConfigMap's list.
   */
  async pushRepos(runner: PodRunner, names: Names, apiKey: string, repos: readonly RepoToSync[]): Promise<boolean> {
    const body = JSON.stringify({ repos: reposFor(runner, repos) });
    const digest = createHash('sha256').update(body).digest('hex');
    if (this.sentRepos.get(names.base) === digest) return true;
    try {
      const res = await this.doFetch(`${this.bridgeUrl(names)}/internal/repos`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        this.log.warn(`claude-pods: ${runner.name}: the bridge of ${names.base} refused the repository list (${res.status}); the pod keeps the list it started with`);
        return false;
      }
      this.sentRepos.set(names.base, digest);
      return true;
    } catch {
      this.log.info(`claude-pods: ${runner.name}: the bridge of ${names.base} did not take the repository list yet; it is tried again on the next pass`);
      return false;
    }
  }

  /**
   * Whether the agent in this pod is signed in, as its bridge says (`GET /v1/auth/status`): the sign-in made from the Runners page lives in the runner's state volume, so a bridge is the only
   * one who knows. Any failure reads as "not signed in" and is tried again on the next pass.
   */
  async signedInBridge(runner: PodRunner, names: Names, apiKey: string): Promise<boolean> {
    try {
      const res = await this.doFetch(`${this.bridgeUrl(names)}/v1/auth/status?agent=${AGENTS[names.agent].profileAgent}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { auth?: { state?: unknown } };
      return body.auth?.state === 'signed_in';
    } catch {
      this.log.info(`claude-pods: ${runner.name}: the bridge of ${names.base} did not answer the sign-in question yet; it is asked again on the next pass`);
      return false;
    }
  }

  /**
   * The deployer's kubeconfig for ONE team's pod: that team's bot named `deployerBot` gets that team's deploy login. Every bot of a pod runs as one user and can read what the run container
   * mounts, but a pod holds one team's bots only (P26-21), so the login never reaches another team's bot. `runner` is the runner as the team's pod sees it.
   */
  private async deployPlan(runner: PodRunner): Promise<DeployPlan> {
    const none: DeployPlan = { bots: new Set(), mounts: [] };
    const deployer = this.cfg.deployerBot;
    if (deployer === '' || !this.source.deployerKubeconfig) return none;
    const mine = runner.bots.filter((b) => b.botSlug === deployer);
    if (mine.length === 0) return none;
    const [teamId, teamSlug] = [mine[0]!.teamId, mine[0]!.teamSlug];
    try {
      const ref = await this.source.deployerKubeconfig({ id: teamId, slug: teamSlug });
      if (!ref) return none;
      return { bots: new Set(mine.map((b) => publisherKey(b.teamSlug, b.botSlug))), mounts: [{ teamSlug, secret: ref.secret, key: ref.key }] };
    } catch (err) {
      this.log.warn(`claude-pods: ${runner.name}: no deployer kubeconfig for ${teamSlug} this pass: ${err instanceof Error ? err.message : String(err)}`);
      return none;
    }
  }

  /**
   * The team pods a runner has: one per team that has a bot on it. A runner with no bot yet still has one pod, so an admin can sign in first: the first team of its list, else a placeholder.
   * The work volume of a runner from before P26-21 (`claude-<runner>-work`) becomes the first team's (or the team it was given to before): the claim is not renamed or copied, the team's pod
   * mounts it, and the claim is labelled with the team so the choice is kept. Every other team starts with a work volume of its own.
   */
  private async podsOf(runner: PodRunner): Promise<TeamPod[]> {
    const byId = new Map<string, PodTeam>();
    for (const b of runner.bots) byId.set(b.teamId, { id: b.teamId, slug: b.teamSlug });
    let teams = [...byId.values()].sort((a, b) => a.slug.localeCompare(b.slug));
    if (teams.length === 0) teams = [[...runner.teams].sort((a, b) => a.slug.localeCompare(b.slug))[0] ?? PLACEHOLDER_TEAM];
    const old = namesFor(runner.name, runner.agent);
    const legacyWork = await this.k8s.get('PersistentVolumeClaim', this.cfg.namespace, old.work);
    const mine = legacyWork !== null && legacyWork.metadata.labels?.[RUNNER_ID] === runner.id && !isTerminating(legacyWork);
    const owner = mine ? (legacyWork.metadata.labels?.[TEAM_ID] ?? teams[0]!.id) : null;
    return teams.map((team) => {
      const names = namesFor(runner.name, runner.agent, team.slug);
      return { team, names: owner === team.id ? { ...names, work: old.work } : names, runner: runnerForTeam(runner, team) };
    });
  }

  /**
   * The runner's pod from before P26-21 (`claude-<runner>`, one pod for every team) is stopped before any team pod starts, so two pods never write one volume at the same time. Returns true
   * while it still runs. Nothing of it is deleted but its bridge key; the Deployment stays at zero replicas, the work volume becomes the first team's (see `podsOf`).
   */
  private async retireOldPod(runner: PodRunner): Promise<boolean> {
    const old = namesFor(runner.name, runner.agent);
    const dep = await this.k8s.get('Deployment', this.cfg.namespace, old.base);
    if (!dep || dep.metadata.labels?.[RUNNER_ID] !== runner.id || dep.metadata.labels?.[TEAM_ID] !== undefined) return false;
    const replicas = (dep.spec as { replicas?: number } | undefined)?.replicas ?? 0;
    if (replicas > 0) {
      await this.scaleToZero(dep);
      this.log.info(`claude-pods: ${runner.name}: the single pod of this runner is stopped; each team gets its own pod (the work volume becomes the first team's)`);
    }
    const pods = await this.k8s.list('Pod', this.cfg.namespace, `manythreads.io/pod=${old.base}`);
    if (replicas > 0 || pods.length > 0) return true;
    // its bridge key goes with it (a key of a pod that no longer exists); every team pod has a key of its own
    const key = await this.k8s.get('Secret', this.cfg.namespace, old.key);
    if (key && key.metadata.labels?.[RUNNER_ID] === runner.id) await this.k8s.delete('Secret', this.cfg.namespace, old.key);
    return false;
  }

  private async scaleToZero(d: K8sObject): Promise<void> {
    await this.k8s.apply({ ...d, metadata: { name: d.metadata.name, namespace: d.metadata.namespace, labels: d.metadata.labels ?? {} }, spec: { ...(d.spec as object), replicas: 0 } });
  }

  /**
   * An object of this team pod that another runner (or another team) owns: two different pairs can spell one plain name (runner `a` with team `b-c`, runner `a-b` with team `c`). The pod is
   * then left alone and the pass says so; it never takes over an object that carries another id. An object with no label at all is not proved foreign.
   */
  private async foreignObject(runner: PodRunner, pod: TeamPod): Promise<string | null> {
    const { names } = pod;
    for (const [kind, name] of [['Deployment', names.base], ['Service', names.base], ['Secret', names.key], ['ConfigMap', names.config], ['PersistentVolumeClaim', names.work]] as const) {
      const o = await this.k8s.get(kind, this.cfg.namespace, name);
      const labels = o?.metadata.labels;
      if (!o || labels === undefined) continue;
      if ((labels[RUNNER_ID] !== undefined && labels[RUNNER_ID] !== runner.id) || (labels[TEAM_ID] !== undefined && labels[TEAM_ID] !== pod.team.id)) return `${kind} ${name}`;
    }
    return null;
  }

  async reconcileRunner(runner: PodRunner): Promise<RunnerResult> {
    const { cfg, k8s } = this;
    const shared = namesFor(runner.name, runner.agent);
    const pods = await this.podsOf(runner);
    const plan = await this.planNode(runner, shared, pods.map((p) => p.names.work));
    const { moving } = plan;
    // Every team pod mounts the runner's one state volume, which lives on one machine: with several pods and no machine chosen they are pinned to where the volumes are.
    const node = plan.node ?? (pods.length > 1 ? plan.site : null);

    const credentials = await k8s.get('Secret', cfg.namespace, shared.credentials);
    const hasCredentials = credentials !== null;
    const uploadId = b64((credentials?.data as Record<string, string> | undefined)?.['upload-id']) || null;
    // A claim that is being deleted (a sign-in removed) is let go first: every pod stops, the claim is freed, and the next pass makes it again.
    const stateClaim = await k8s.get('PersistentVolumeClaim', cfg.namespace, shared.state);
    const claimGoing = stateClaim !== null && isTerminating(stateClaim);
    const oldPodRuns = await this.retireOldPod(runner);

    const stampOf = (claim: string): string | null => (claim in plan.stamp ? (plan.stamp[claim] ?? null) : node);
    const keeperPod = pods[0]?.names.base;
    const running: { pod: TeamPod; apiKey: string; repos: RepoToSync[] }[] = [];
    const pending: K8sObject[] = [];
    let replicasTotal = 0;
    let anyBots = false;

    const sharedObjects: K8sObject[] = [
      // While a move is under way the claims are left alone (a claim that is being deleted must not be applied again).
      ...(moving || claimGoing ? [] : [buildPvc(cfg, runner, shared.state, cfg.stateSize, stampOf(shared.state))]),
      // the keeper and its rights exist only for a runner with an uploaded sign-in file
      ...(hasCredentials ? buildKeeperRbac(cfg, runner, shared) : []),
    ];
    for (const obj of sharedObjects) await k8s.apply(obj);

    for (const pod of pods) {
      const { names, team } = pod;
      const foreign = await this.foreignObject(runner, pod);
      if (foreign !== null) {
        this.log.warn(`claude-pods: ${runner.name}: no pod is made for team ${team.slug}: ${foreign} belongs to another runner or team`);
        continue;
      }
      const prevKey = await k8s.get('Secret', cfg.namespace, names.key);
      const apiKey = b64((prevKey?.data as Record<string, string> | undefined)?.['api-key']) || this.newKey();
      const bots = pod.runner.bots;
      if (bots.length > 0) anyBots = true;

      // this team's repositories only
      const repoRows = bots.length > 0 && this.source.reposForTeams ? await this.source.reposForTeams([team.id]) : [];
      const repos: RepoToSync[] = [];
      // the same origin rule as the Hermes pods: a plain https address with an allowed prefix, else the project is left out
      for (const r of withProjectRepos({ repos: [] as RepoConfig['repos'], repoOriginAllow: cfg.repoOriginAllow }, repoRows.filter((x) => x.teamSlug === team.slug)).repos) {
        if (r.origin) repos.push({ teamSlug: team.slug, name: r.name, origin: r.origin, ...(r.branch ? { branch: r.branch } : {}) });
      }

      // this team's bots that may publish (their definition grants tasks.pull_request) and this team's push Secret: nothing of another team is mounted
      const publishers = new Set<string>();
      const pushSecrets: { teamSlug: string; secret: string }[] = [];
      if (publisherOn(cfg) && bots.length > 0) {
        if (this.source.publishersForTeams) for (const p of await this.source.publishersForTeams([team.id])) publishers.add(publisherKey(p.teamSlug, p.botSlug));
        pushSecrets.push({ teamSlug: team.slug, secret: await this.pushSecretOf(team) });
      }
      const deploy = await this.deployPlan(pod.runner);
      const profilesSha = createHash('sha256').update(buildBridgeConfig(cfg, pod.runner, publishers, deploy, names)).digest('hex').slice(0, 16);

      // A runner signed in through the Runners page has its sign-in inside the pod, so the pod runs before there is a sign-in (and, with no bot yet, so that an admin can sign in first).
      const replicas = runner.enabled && (bots.length > 0 || !hasCredentials) && !moving && !claimGoing && !oldPodRuns ? 1 : 0;
      replicasTotal += replicas;
      const objects: K8sObject[] = [
        ...(moving ? [] : [buildPvc(cfg, runner, names.work, cfg.workSize, stampOf(names.work), teamLabels(team))]),
        buildKeySecret(cfg, pod.runner, names, apiKey),
        buildConfigMap(cfg, pod.runner, names, repos, publishers, deploy),
        buildService(cfg, pod.runner, names),
        buildDeployment(cfg, pod.runner, names, {
          replicas,
          node,
          moving,
          held: plan.held,
          uploadId,
          pushSecrets,
          profilesSha,
          keeper: hasCredentials && names.base === keeperPod,
          signinFile: hasCredentials,
          deployMounts: deploy.mounts,
        }),
      ];
      for (const obj of objects) await k8s.apply(obj);
      const podObjs = await k8s.list('Pod', cfg.namespace, `manythreads.io/pod=${names.base}`);
      pending.push(...podObjs);
      if (podObjs.some((p) => phaseOf(p) === 'Running')) running.push({ pod, apiKey, repos });
    }

    // Deployments of a team that no longer has a bot here (and the placeholder, once a real team is there) are stopped; their volumes and Secrets stay.
    await this.stopStaleDeployments(runner, new Set(pods.map((p) => p.names.base)));
    if (moving && plan.stale.length > 0) await this.finishMove(runner, plan.stale);

    const phases = pending.map(phaseOf);
    const signedIn = !hasCredentials && running.length > 0 ? await this.anySignedIn(running) : false;
    const state = stateFor({
      hasCredentials,
      signedIn,
      hasBots: anyBots,
      enabled: runner.enabled,
      moving,
      held: plan.held,
      pending: phases.includes('Pending'),
      unschedulable: pending.some((p) => unschedulable(p)),
      running: running.length > 0,
    });
    if (state.status === 'ready') {
      // a pod that is up takes the repository list now; a pod that is not up starts from the ConfigMap's copy
      for (const { pod, apiKey, repos } of running) await this.pushRepos(pod.runner, pod.names, apiKey, repos);
    }
    await this.source.report?.({ runnerId: runner.id, status: state.status, detail: state.detail });
    return { runner: runner.name, pod: pods[0]?.names.base ?? shared.base, pods: pods.map((p) => p.names.base), replicas: replicasTotal, node, moving, held: plan.held, state: state.status };
  }

  /** The sign-in is the runner's, not a pod's: the first running team pod whose bridge says signed in is enough. */
  private async anySignedIn(running: readonly { pod: TeamPod; apiKey: string }[]): Promise<boolean> {
    for (const { pod, apiKey } of running) if (await this.signedInBridge(pod.runner, pod.names, apiKey)) return true;
    return false;
  }

  private async stopStaleDeployments(runner: PodRunner, wanted: ReadonlySet<string>): Promise<void> {
    const deps = await this.k8s.list('Deployment', this.cfg.namespace, `${RUNNER_ID}=${runner.id}`);
    for (const d of deps) {
      if (d.metadata.labels?.[TEAM_ID] === undefined || wanted.has(d.metadata.name)) continue;
      if (((d.spec as { replicas?: number } | undefined)?.replicas ?? 0) === 0) continue;
      await this.scaleToZero(d);
      this.log.info(`claude-pods: ${d.metadata.name}: no bot of this team is on ${runner.name} any more, so its pod is stopped (its volumes and Secrets are kept)`);
    }
  }

  private pinnedNode(runner: PodRunner): string | null {
    if (runner.node === null) return null;
    if (!isNodeLabelValue(runner.node)) {
      this.log.warn(`claude-pods: ${runner.name}: the machine chosen for this runner is not a usable node name, so the pod is not pinned`);
      return null;
    }
    return runner.node;
  }

  /**
   * Which machine the runner's pods are pinned to and whether its volumes move. Volumes are deleted only by a move an admin confirmed (the same rule as the Hermes pods):
   * no claims yet or claims on the chosen machine: pin to it; claims elsewhere and no confirmation in the last 15 minutes: HELD, the pods stay where their data is;
   * confirmed and the machine is an existing, Ready node the admin may choose: stop every pod of the runner, delete all its claims (the shared state and each team's work) once no pod is left.
   * The state volume is shared by all the runner's pods, so the pods move together or not at all.
   */
  private async planNode(runner: PodRunner, shared: Names, workClaims: readonly string[]): Promise<NodePlan> {
    const wanted = this.pinnedNode(runner);
    const claimNames = [shared.state, ...workClaims];
    const claims = new Map<string, K8sObject | null>();
    for (const n of claimNames) claims.set(n, await this.k8s.get('PersistentVolumeClaim', this.cfg.namespace, n));
    const existing = claimNames.filter((n) => claims.get(n) != null);

    let nodeObjects: K8sObject[] | null | undefined;
    const nodesNow = async (): Promise<K8sObject[] | null> => {
      if (nodeObjects !== undefined) return nodeObjects;
      try {
        nodeObjects = (await this.k8s.listNodes?.()) ?? null;
      } catch (err) {
        this.log.warn(`claude-pods: ${runner.name}: cannot list the cluster's nodes: ${err instanceof Error ? err.message : String(err)}`);
        nodeObjects = null;
      }
      return nodeObjects;
    };

    const sites = new Map<string, { node: string | null; unknown: boolean }>();
    const lookup = existing.some((n) => needsNodeLookup(claims.get(n) ?? null)) ? await nodesNow() : null;
    for (const n of existing) sites.set(n, volumeSite(claims.get(n) ?? null, lookup));
    const stamp: Record<string, string | null> = {};
    for (const n of existing) {
      const site = sites.get(n)!;
      stamp[n] = site.node ?? (site.unknown ? null : wanted);
    }
    const realNode = claimNames.map((n) => sites.get(n)?.node ?? null).find((x) => x !== null) ?? null;

    if (wanted === null) return { node: null, site: realNode, stamp, moving: false, held: null, stale: [] };
    const away = existing.some((n) => {
      const at = sites.get(n)!.node;
      return at !== null && at !== wanted;
    });
    if (!away) return { node: wanted, site: realNode, stamp, moving: false, held: null, stale: [] };

    const deps = await this.k8s.list('Deployment', this.cfg.namespace, `${RUNNER_ID}=${runner.id}`);
    const underWay = deps.some((d) => d.metadata.annotations?.[MOVING_ANNOTATION] === wanted);
    const confirmed = underWay || existing.every((n) => confirmedFor(claims.get(n)!, wanted, this.now()));
    const hold: NodePlan = { node: realNode, site: realNode, stamp, moving: false, held: wanted, stale: [] };
    if (!confirmed) {
      this.log.info(`claude-pods: ${runner.name}: the machine chosen changed and its volumes are on another machine; nothing is moved until an admin confirms the move`);
      return hold;
    }
    const why = await this.targetProblem(wanted, nodesNow);
    if (why !== null) {
      this.log.warn(`claude-pods: ${runner.name}: not moving the volumes: ${why}`);
      return underWay ? { node: wanted, site: realNode, stamp, moving: true, held: null, stale: [] } : hold;
    }
    return { node: wanted, site: realNode, stamp, moving: true, held: null, stale: existing };
  }

  private async targetProblem(node: string, nodesNow: () => Promise<K8sObject[] | null>): Promise<string | null> {
    const allowed = this.cfg.allowedNodes;
    if (allowed.length > 0 && !allowed.includes(node)) return 'the machine is not on the list of machines an admin may choose (botRunners.allowedNodes)';
    const objects = await nodesNow();
    if (objects === null) return "the cluster's nodes cannot be read, so the machine cannot be checked";
    const found = objects.find((o) => (o.metadata.labels?.['kubernetes.io/hostname'] ?? o.metadata.name) === node);
    if (!found) return 'the machine is not a node of this cluster';
    const ready = ((found.status as { conditions?: { type: string; status: string }[] } | undefined)?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
    return ready ? null : 'the machine is not Ready';
  }

  /**
   * Second half of a move: once no pod of the runner is left (any team's), all its claims are deleted (only when every one carries this runner's id label); the next pass makes them new on the
   * chosen machine. Everything on them is lost: the clones and the work files of every team, and the state folder. The Secrets (the keys and the sign-in file) are never touched.
   */
  private async finishMove(runner: PodRunner, claimNames: readonly string[]): Promise<void> {
    const pods = await this.k8s.list('Pod', this.cfg.namespace, `${RUNNER_ID}=${runner.id}`);
    if (pods.length > 0) {
      this.log.info(`claude-pods: ${runner.name}: moving the pods; waiting for them to stop before their volumes are made again`);
      return;
    }
    const claims: K8sObject[] = [];
    for (const name of claimNames) {
      const claim = await this.k8s.get('PersistentVolumeClaim', this.cfg.namespace, name);
      if (!claim) continue;
      if (claim.metadata.labels?.[RUNNER_ID] !== runner.id) {
        this.log.warn(`claude-pods: ${runner.name}: the volume claim ${name} does not carry this runner's id, so no volume is deleted`);
        return;
      }
      claims.push(claim);
    }
    for (const claim of claims) if (!isTerminating(claim)) await this.k8s.delete('PersistentVolumeClaim', this.cfg.namespace, claim.metadata.name);
    this.log.info(`claude-pods: ${runner.name}: the volumes are being made again on the chosen machine`);
  }

  /** One pass over every Claude and Codex runner; a runner that fails is logged and does not stop the others. A Deployment of a runner that no longer exists is scaled to zero (never deleted). */
  async reconcileAll(): Promise<RunnerResult[]> {
    const runners = await this.source.runners();
    const results: RunnerResult[] = [];
    for (const runner of runners) {
      try {
        results.push(await this.reconcileRunner(runner));
      } catch (err) {
        this.log.warn(`claude-pods: runner ${runner.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const known = new Set(runners.map((r) => r.id));
      const deps = await this.k8s.list('Deployment', this.cfg.namespace, `app.kubernetes.io/component=${COMPONENT},app.kubernetes.io/managed-by=${MANAGED_BY}`);
      for (const d of deps) {
        const id = d.metadata.labels?.[RUNNER_ID];
        const replicas = (d.spec as { replicas?: number } | undefined)?.replicas ?? 0;
        if (!id || known.has(id) || replicas === 0) continue;
        await this.scaleToZero(d);
        this.log.info(`claude-pods: ${d.metadata.name}: the runner is gone, so the pod is stopped (its volumes and Secrets are kept)`);
      }
    } catch (err) {
      this.log.warn(`claude-pods: listing pods: ${err instanceof Error ? err.message : String(err)}`);
    }
    return results;
  }

  /**
   * Where each runner's pods stand (for the admin page): one answer per runner, from all its team pods. A pod that is pending makes the runner pending; the machine is the one of a pod that
   * runs (or waits); the volume's machine is where the runner's shared state volume is. The old single pod of a runner (no team label) counts until it is gone.
   */
  async placements(runnerIds: readonly string[] | null): Promise<ClaudePodPlacement[]> {
    const { cfg, k8s } = this;
    const deps = await k8s.list('Deployment', cfg.namespace, `app.kubernetes.io/component=${COMPONENT},app.kubernetes.io/managed-by=${MANAGED_BY}`);
    const byRunner = new Map<string, K8sObject[]>();
    for (const d of deps) {
      const id = d.metadata.labels?.[RUNNER_ID];
      if (!id || (runnerIds !== null && !runnerIds.includes(id))) continue;
      byRunner.set(id, [...(byRunner.get(id) ?? []), d]);
    }
    const out: ClaudePodPlacement[] = [];
    for (const [id, list] of byRunner) {
      const live: K8sObject[] = [];
      let pendingPod: K8sObject | undefined;
      let anyPod = false;
      for (const d of list) {
        for (const p of await k8s.list('Pod', cfg.namespace, `manythreads.io/pod=${d.metadata.name}`)) {
          anyPod = true;
          if (phaseOf(p) === 'Running') live.push(p);
          else pendingPod ??= p;
        }
      }
      const claims = await k8s.list('PersistentVolumeClaim', cfg.namespace, `${RUNNER_ID}=${id}`);
      // the shared state volume says where the runner's data is; an old runner without one yet falls back to a work volume
      const claim = claims.find((c) => c.metadata.name.endsWith('-state')) ?? claims.find((c) => c.metadata.name.endsWith('-work')) ?? null;
      const site = claim ? volumeSite(claim, needsNodeLookup(claim) ? ((await k8s.listNodes?.().catch(() => null)) ?? null) : null) : { node: null, unknown: false };
      const phase = !anyPod ? 'absent' : pendingPod !== undefined ? 'pending' : 'running';
      const shown = live[0] ?? pendingPod;
      out.push({
        runnerId: id,
        phase,
        node: String((shown?.spec as { nodeName?: string } | undefined)?.nodeName ?? '') || null,
        volumeNode: site.node,
        moving: list.some((d) => d.metadata.annotations?.[MOVING_ANNOTATION] !== undefined),
        moveHeld: list.some((d) => d.metadata.annotations?.[MOVE_HELD_ANNOTATION] !== undefined),
        pendingReason: phase === 'pending' ? (pendingPod && unschedulable(pendingPod) ? 'unschedulable' : 'starting') : null,
      });
    }
    return out;
  }
}

function unschedulable(pod: K8sObject): boolean {
  const conds = (pod.status as { conditions?: { type: string; status: string; reason?: string }[] } | undefined)?.conditions ?? [];
  return conds.some((c) => c.type === 'PodScheduled' && c.status === 'False' && c.reason === 'Unschedulable');
}
