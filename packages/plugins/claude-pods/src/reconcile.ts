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
  publisherKey,
  publisherOn,
  pushSecretName,
  reposFor,
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
  /** Tell the catalog how the pod is doing. */
  report?(state: PodRunnerState): Promise<void>;
}

interface NodePlan {
  node: string | null;
  stamp: Record<string, string | null>;
  moving: boolean;
  held: string | null;
  stale: string[];
}

export interface RunnerResult {
  runner: string;
  pod: string;
  replicas: number;
  node: string | null;
  moving: boolean;
  held: string | null;
  state: PodRunnerState['status'];
}

/** The decision of what to report, from facts only: a pod is never "ready" before it has a sign-in file and a running container. */
export function stateFor(input: { hasCredentials: boolean; hasBots: boolean; enabled: boolean; moving: boolean; held: string | null; pending: boolean; unschedulable: boolean; running: boolean }): { status: PodRunnerState['status']; detail: string | null } {
  if (input.moving) return { status: 'moving', detail: 'Moving to the machine you chose. The work volume is being made again.' };
  if (!input.hasCredentials) return { status: 'waiting_for_sign_in', detail: 'Waiting for a sign-in file. Upload one to start this runner.' };
  if (input.held !== null) return { status: 'waiting_for_node', detail: 'The machine changed, but the move is not confirmed. The pod stays where its data is.' };
  if (input.pending && input.unschedulable) return { status: 'waiting_for_node', detail: 'Waiting for its machine: the pod cannot be placed there yet.' };
  if (input.running) return { status: 'ready', detail: null };
  if (!input.enabled || !input.hasBots) return { status: 'starting', detail: input.enabled ? 'No bot is placed on this runner yet, so its pod is stopped.' : null };
  return { status: 'starting', detail: 'The pod is starting.' };
}

const b64 = (s: string | undefined): string => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

/** Brings the Kubernetes objects of every Claude Code and Codex runner in line with the catalog. Safe to run repeatedly; it touches only objects it labelled itself. */
export class Reconciler {
  constructor(
    private readonly k8s: K8s,
    private readonly cfg: ClaudePodConfig,
    private readonly source: RunnerSource,
    private readonly log: PluginLogger,
    private readonly newKey: () => string = () => randomBytes(24).toString('hex'),
    private readonly now: () => number = Date.now,
    /** Test seams: the HTTP client the repository list is sent with, and the address of a runner's bridge. */
    private readonly doFetch: typeof fetch = fetch,
    private readonly bridgeUrl: (names: Names) => string = (names) => `http://${names.base}.${cfg.namespace}.svc:${BRIDGE_PORT}`,
  ) {}

  /** What the bridge of each runner was last sent (a hash of the list), so an unchanged list is not sent again. A failed send is not recorded and is tried again. */
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
   * Sends the repository list to the runner's bridge (decision E4): the ConfigMap copy reaches a pod after about a minute, this reaches the repo-sync container in seconds.
   * Returns whether the bridge took it. Any failure (the pod is not up yet, or restarting) is logged in words and tried again on the next pass; the pod starts from the ConfigMap's list.
   */
  async pushRepos(runner: PodRunner, names: Names, apiKey: string, repos: readonly RepoToSync[]): Promise<boolean> {
    const body = JSON.stringify({ repos: reposFor(runner, repos) });
    const digest = createHash('sha256').update(body).digest('hex');
    if (this.sentRepos.get(runner.id) === digest) return true;
    try {
      const res = await this.doFetch(`${this.bridgeUrl(names)}/internal/repos`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        this.log.warn(`claude-pods: ${runner.name}: the bridge refused the repository list (${res.status}); the pod keeps the list it started with`);
        return false;
      }
      this.sentRepos.set(runner.id, digest);
      return true;
    } catch {
      this.log.info(`claude-pods: ${runner.name}: the bridge did not take the repository list yet; it is tried again on the next pass`);
      return false;
    }
  }

  async reconcileRunner(runner: PodRunner): Promise<RunnerResult> {
    const { cfg, k8s } = this;
    const names = namesFor(runner.name, runner.agent);
    const plan = await this.planNode(runner, names);
    const { node, moving } = plan;

    const prevKey = await k8s.get('Secret', cfg.namespace, names.key);
    const apiKey = b64((prevKey?.data as Record<string, string> | undefined)?.['api-key']) || this.newKey();
    const credentials = await k8s.get('Secret', cfg.namespace, names.credentials);
    const hasCredentials = credentials !== null;
    const uploadId = b64((credentials?.data as Record<string, string> | undefined)?.['upload-id']) || null;

    const repoRows = runner.teams.length > 0 && this.source.reposForTeams ? await this.source.reposForTeams(runner.teams.map((t) => t.id)) : [];
    const repos: RepoToSync[] = [];
    for (const team of new Set(runner.bots.map((b) => b.teamSlug))) {
      const mine = repoRows.filter((r) => r.teamSlug === team);
      // the same origin rule as the Hermes pods: a plain https address with an allowed prefix, else the project is left out
      for (const r of withProjectRepos({ repos: [] as RepoConfig['repos'], repoOriginAllow: cfg.repoOriginAllow }, mine).repos) {
        if (r.origin) repos.push({ teamSlug: team, name: r.name, origin: r.origin, ...(r.branch ? { branch: r.branch } : {}) });
      }
    }

    // the bots of this runner that may publish (their definition grants tasks.pull_request) and the push Secret of each team on it
    const publishers = new Set<string>();
    const pushSecrets: { teamSlug: string; secret: string }[] = [];
    if (publisherOn(cfg)) {
      const teams = [...new Map(runner.bots.map((b) => [b.teamId, b.teamSlug])).entries()].map(([id, slug]) => ({ id, slug }));
      if (teams.length > 0 && this.source.publishersForTeams) for (const p of await this.source.publishersForTeams(teams.map((t) => t.id))) publishers.add(publisherKey(p.teamSlug, p.botSlug));
      for (const t of teams) pushSecrets.push({ teamSlug: t.slug, secret: await this.pushSecretOf(t) });
    }
    const profilesSha = createHash('sha256').update(buildBridgeConfig(cfg, runner, publishers)).digest('hex').slice(0, 16);

    const stampOf = (claim: string): string | null => (claim in plan.stamp ? (plan.stamp[claim] ?? null) : node);
    const replicas = runner.enabled && runner.bots.length > 0 && hasCredentials && !moving ? 1 : 0;
    const objects: K8sObject[] = [
      // While a move is under way the claims are left alone (a claim that is being deleted must not be applied again).
      ...(moving ? [] : [buildPvc(cfg, runner, names.state, cfg.stateSize, stampOf(names.state)), buildPvc(cfg, runner, names.work, cfg.workSize, stampOf(names.work))]),
      ...buildKeeperRbac(cfg, runner, names),
      buildKeySecret(cfg, runner, names, apiKey),
      buildConfigMap(cfg, runner, names, repos, publishers),
      buildService(cfg, runner, names),
      buildDeployment(cfg, runner, names, { replicas, node, moving, held: plan.held, uploadId, pushSecrets, profilesSha }),
    ];
    for (const obj of objects) await k8s.apply(obj);
    if (moving && plan.stale.length > 0) await this.finishMove(runner, names, plan.stale);

    const pods = await k8s.list('Pod', cfg.namespace, `manythreads.io/pod=${names.base}`);
    const phase = (p: K8sObject): string => String((p.status as { phase?: string } | undefined)?.phase ?? '');
    const state = stateFor({
      hasCredentials,
      hasBots: runner.bots.length > 0,
      enabled: runner.enabled,
      moving,
      held: plan.held,
      pending: pods.some((p) => phase(p) === 'Pending'),
      unschedulable: pods.some((p) => unschedulable(p)),
      running: pods.some((p) => phase(p) === 'Running'),
    });
    // a pod that is up takes the repository list now; a pod that is not up starts from the ConfigMap's copy
    if (state.status === 'ready') await this.pushRepos(runner, names, apiKey, repos);
    await this.source.report?.({ runnerId: runner.id, status: state.status, detail: state.detail });
    return { runner: runner.name, pod: names.base, replicas, node, moving, held: plan.held, state: state.status };
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
   * Which machine the pod is pinned to and whether its volumes move. Volumes are deleted only by a move an admin confirmed (the same rule as the Hermes pods):
   * no claims yet or claims on the chosen machine: pin to it; claims elsewhere and no confirmation in the last 15 minutes: HELD, the pod stays where its data is;
   * confirmed and the machine is an existing, Ready node the admin may choose: stop the pod, delete both claims once no pod is left.
   */
  private async planNode(runner: PodRunner, names: Names): Promise<NodePlan> {
    const wanted = this.pinnedNode(runner);
    const claimNames = [names.state, names.work];
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

    if (wanted === null) return { node: null, stamp, moving: false, held: null, stale: [] };
    const away = existing.some((n) => {
      const at = sites.get(n)!.node;
      return at !== null && at !== wanted;
    });
    if (!away) return { node: wanted, stamp, moving: false, held: null, stale: [] };

    const dep = await this.k8s.get('Deployment', this.cfg.namespace, names.base);
    const underWay = dep?.metadata.annotations?.[MOVING_ANNOTATION] === wanted;
    const confirmed = underWay || existing.every((n) => confirmedFor(claims.get(n)!, wanted, this.now()));
    const hold: NodePlan = { node: realNode, stamp, moving: false, held: wanted, stale: [] };
    if (!confirmed) {
      this.log.info(`claude-pods: ${runner.name}: the machine chosen changed and its volumes are on another machine; nothing is moved until an admin confirms the move`);
      return hold;
    }
    const why = await this.targetProblem(wanted, nodesNow);
    if (why !== null) {
      this.log.warn(`claude-pods: ${runner.name}: not moving the volumes: ${why}`);
      return underWay ? { node: wanted, stamp, moving: true, held: null, stale: [] } : hold;
    }
    return { node: wanted, stamp, moving: true, held: null, stale: existing };
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
   * Second half of a move: once no pod of the runner is left, both claims are deleted (only when both carry this runner's id label); the next pass makes them new on the chosen
   * machine. Everything on them is lost: the clones and the work files, and the state folder. The Secrets (the key and the sign-in file) are never touched.
   */
  private async finishMove(runner: PodRunner, names: Names, claimNames: readonly string[]): Promise<void> {
    const pods = await this.k8s.list('Pod', this.cfg.namespace, `manythreads.io/pod=${names.base}`);
    if (pods.length > 0) {
      this.log.info(`claude-pods: ${runner.name}: moving the pod; waiting for it to stop before its volumes are made again`);
      return;
    }
    const claims: K8sObject[] = [];
    for (const name of claimNames) {
      const claim = await this.k8s.get('PersistentVolumeClaim', this.cfg.namespace, name);
      if (!claim) continue;
      if (claim.metadata.labels?.['manythreads.io/runner-id'] !== runner.id) {
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
        const id = d.metadata.labels?.['manythreads.io/runner-id'];
        const replicas = (d.spec as { replicas?: number } | undefined)?.replicas ?? 0;
        if (!id || known.has(id) || replicas === 0) continue;
        await this.k8s.apply({ ...d, metadata: { name: d.metadata.name, namespace: d.metadata.namespace, labels: d.metadata.labels ?? {} }, spec: { ...(d.spec as object), replicas: 0 } });
        this.log.info(`claude-pods: ${d.metadata.name}: the runner is gone, so the pod is stopped (its volumes and Secrets are kept)`);
      }
    } catch (err) {
      this.log.warn(`claude-pods: listing pods: ${err instanceof Error ? err.message : String(err)}`);
    }
    return results;
  }

  /** Where each runner's pod stands (for the admin page). */
  async placements(runnerIds: readonly string[] | null): Promise<ClaudePodPlacement[]> {
    const { cfg, k8s } = this;
    const deps = await k8s.list('Deployment', cfg.namespace, `app.kubernetes.io/component=${COMPONENT},app.kubernetes.io/managed-by=${MANAGED_BY}`);
    const out: ClaudePodPlacement[] = [];
    for (const d of deps) {
      const id = d.metadata.labels?.['manythreads.io/runner-id'];
      if (!id || (runnerIds !== null && !runnerIds.includes(id))) continue;
      const base = d.metadata.name;
      const pods = await k8s.list('Pod', cfg.namespace, `manythreads.io/pod=${base}`);
      const live = pods.find((p) => String((p.status as { phase?: string } | undefined)?.phase) === 'Running') ?? pods[0];
      const phase = pods.length === 0 ? 'absent' : String((live?.status as { phase?: string } | undefined)?.phase) === 'Running' ? 'running' : 'pending';
      const work = (await k8s.list('PersistentVolumeClaim', cfg.namespace, `manythreads.io/runner-id=${id}`)).find((c) => c.metadata.name === `${base}-work`) ?? null;
      const site = work ? volumeSite(work, needsNodeLookup(work) ? ((await k8s.listNodes?.().catch(() => null)) ?? null) : null) : { node: null, unknown: false };
      out.push({
        runnerId: id,
        phase,
        node: String((live?.spec as { nodeName?: string } | undefined)?.nodeName ?? '') || null,
        volumeNode: site.node,
        moving: d.metadata.annotations?.[MOVING_ANNOTATION] !== undefined,
        moveHeld: d.metadata.annotations?.[MOVE_HELD_ANNOTATION] !== undefined,
        pendingReason: phase === 'pending' ? (live && unschedulable(live) ? 'unschedulable' : 'starting') : null,
      });
    }
    return out;
  }
}

function unschedulable(pod: K8sObject): boolean {
  const conds = (pod.status as { conditions?: { type: string; status: string; reason?: string }[] } | undefined)?.conditions ?? [];
  return conds.some((c) => c.type === 'PodScheduled' && c.status === 'False' && c.reason === 'Unschedulable');
}
