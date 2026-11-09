import { randomBytes } from 'node:crypto';
import type { GatewayProfileSpec, PluginLogger } from '@manythreads/sdk';
import { assertGatewayOnly, profileViolation } from './gateway-only.ts';
import type { K8s, K8sObject } from './k8s.ts';
import { withProjectRepos, type ProjectRepo } from './project-repos.ts';
import { confirmedFor, isTerminating, needsNodeLookup, volumeSite } from './move.ts';
import { toClusterNode } from './nodes.ts';
import {
  GATEWAY_PORT,
  MOVING_ANNOTATION,
  MOVE_HELD_ANNOTATION,
  appUrlPattern,
  appsNamespaceFor,
  assignUsers,
  botSlugOf,
  buildBotsConfigMap,
  buildDeployerSecretFor,
  buildDeployment,
  buildKeySecret,
  buildProfilesSecret,
  buildPvc,
  buildService,
  type DeployTargetLogin,
  labelsFor,
  namesFor,
  type Names,
  isNodeLabelValue,
  proxyUrlOf,
  type PodConfig,
  type Team,
} from './render.ts';

/** What the controller needs from the platform: a team's profiles and a place to tell where the team's pod answers. */
export interface ProfileSource {
  profilesForTeam(teamId: string): Promise<GatewayProfileSpec[]>;
  /** The team's projects as repositories of record (name and https address); absent in the test-only static mode. */
  reposForTeam?(teamId: string): Promise<ProjectRepo[]>;
  /** Slugs of the team's bots whose definition grants `tasks.pull_request` (they may run `mt-publish.sh`); absent in the test-only static mode. */
  publishersForTeam?(teamId: string): Promise<string[]>;
  /** The machine the team's pod is pinned to (the node of the pod runner the team uses; P19-08), or null for none. Absent in the test-only static mode: no pinning. */
  nodeForTeam?(teamId: string): Promise<string | null>;
  /**
   * The proxy address of the team's outbound rule when the rule is on (`app.team_egress`: `enforce` and `proxy_url`), or null. Absent in the test-only static mode: no proxy.
   * A read that fails fails the pass: a pass that cannot tell must not move a pod out of, or into, the proxy.
   */
  proxyForTeam?(teamId: string): Promise<string | null>;
  /** Absent in the test-only static mode. */
  setManagedGateway?(teamId: string, input: { baseUrl: string }): Promise<void>;
}

export interface TeamResult {
  team: string;
  pod: string;
  profiles: number;
  deployer: boolean;
  gatewayUrl: string;
  /** The machine the pod is pinned to, or null. */
  node: string | null;
  /** The pod's volumes are being recreated on `node` (a move in progress): the pod is stopped until they are. */
  moving: boolean;
  /** The machine now wanted for this team when the pod's volumes are tied to another one and nobody confirmed the move: nothing is stopped or deleted. Null otherwise. */
  held: string | null;
}

/** What one pass decided about the team's machine. */
interface NodePlan {
  /** The machine the pod is pinned to (the volumes' own machine while a move is held). */
  node: string | null;
  /** The machine each existing claim is stamped with (`manythreads.io/node`); a claim not there yet gets `node`. */
  stamp: Record<string, string | null>;
  moving: boolean;
  held: string | null;
  /** The claims to delete once the pod is gone (a confirmed, verified move). */
  stale: string[];
}

/** The names for a team: plain `hermes-<slug>` unless another team's pod already holds that name. */
export async function resolvePodNames(k8s: K8s, cfg: Pick<PodConfig, 'namespace'>, team: Team): Promise<Names> {
  const plain = namesFor(team);
  const existing = await k8s.get('Deployment', cfg.namespace, plain.base);
  const owner = existing?.metadata.labels?.['manythreads.io/team-id'];
  return existing && owner !== undefined && owner !== team.id ? namesFor(team, true) : plain;
}

const b64 = (s: string | undefined): string => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

/** Brings the Kubernetes objects of one team's pod in line with the profiles the platform renders. Safe to run repeatedly. */
export class Reconciler {
  private readonly announced = new Set<string>();

  constructor(
    private readonly k8s: K8s,
    private readonly cfg: PodConfig,
    private readonly source: ProfileSource,
    private readonly log: PluginLogger,
    private readonly newKey: () => string = () => randomBytes(24).toString('hex'),
    private readonly now: () => number = Date.now,
  ) {}

  /** The names for a team: plain `hermes-<slug>` unless another team's pod already holds that name. */
  private resolveNames(team: Team): Promise<Names> {
    return resolvePodNames(this.k8s, this.cfg, team);
  }

  /**
   * The team's deploy targets whose token is ready; one that is not (yet) is left out with a warning. `failed` is true when a read errored (as
   * opposed to the token simply not being ready): the caller then keeps the kubeconfig it wrote last time instead of dropping that context.
   */
  private async deployTargetLogins(team: Team): Promise<{ logins: DeployTargetLogin[]; failed: boolean }> {
    const out: DeployTargetLogin[] = [];
    let failed = false;
    for (const t of this.cfg.deployTargets ?? []) {
      if (t.team !== team.slug) continue;
      try {
        const tok = await this.k8s.get('Secret', t.namespace, 'deployer-token');
        const data = (tok?.data ?? {}) as Record<string, string>;
        const token = b64(data['token']);
        if (token !== '') out.push({ namespace: t.namespace, hosts: t.hosts, token, caPem: b64(data['ca.crt']) });
        else this.log.warn(`hermes-pods: there is no ready deployer token in ${t.namespace}; the deployer bot of ${team.slug} gets no context for it`);
      } catch (err) {
        failed = true;
        this.log.warn(`hermes-pods: cannot read the deployer token of ${t.namespace}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { logins: out, failed };
  }

  async reconcileTeam(team: Team, profilesOverride?: GatewayProfileSpec[]): Promise<TeamResult> {
    const { cfg, k8s } = this;
    // A profile that names a model provider's key or address is left out: a Hermes pod reaches models only through the platform's gateway (P19-10).
    const profiles = (profilesOverride ?? (await this.source.profilesForTeam(team.id))).filter((p) => {
      const why = profileViolation(p);
      // The logger of a plugin has no error level, so the line says plainly that a live bot lost its profile (the name is the bot's `mt-<slug>`; no key or value is in it).
      if (why !== null) this.log.warn(`hermes-pods: ERROR: ${team.slug}: the pod profile ${p.profile} was DROPPED and its bot has no profile in the pod until this is fixed. ${why}`);
      return why === null;
    });
    const names = await this.resolveNames(team);
    const plan = await this.planNode(team, names);
    const { node, moving } = plan;

    // stable per-pod state: uids already handed out, the gateway key already drawn
    const prevBots = await k8s.get('ConfigMap', cfg.namespace, names.bots);
    const existingUids: Record<string, number> = {};
    try {
      const doc = JSON.parse(prevBots?.data && typeof (prevBots.data as Record<string, string>)['bots.json'] === 'string' ? (prevBots.data as Record<string, string>)['bots.json']! : '{}') as { bots?: { user: string; uid: number }[] };
      for (const b of doc.bots ?? []) existingUids[b.user] = b.uid;
    } catch {
      /* a damaged ConfigMap is rebuilt below */
    }
    const prevKey = await k8s.get('Secret', cfg.namespace, names.key);
    const apiKey = b64((prevKey?.data as Record<string, string> | undefined)?.['api-key']) || this.newKey();

    const publishers = new Set((await this.source.publishersForTeam?.(team.id)) ?? []);
    const users = assignUsers(profiles, existingUids, cfg.deployerBot, publishers);
    const projectRepos = (await this.source.reposForTeam?.(team.id)) ?? [];
    // the team's own proxy: stored as text by an admin, so it is looked at again before it reaches a pod
    const storedProxy = (await this.source.proxyForTeam?.(team.id)) ?? null;
    const proxy = proxyUrlOf(storedProxy);
    if (storedProxy !== null && proxy === null) this.log.warn(`hermes-pods: ${team.slug}: the team's proxy address is not usable (it must be http(s)://host[:port], with no sign-in, path or loopback address), so the pod is started without a proxy`);

    // the deployer credential, for the deployer bot only
    let withDeployer = false;
    let deployerSecret: K8sObject | null = null;
    if (users.some((u) => u.deployer)) {
      const appsNs = appsNamespaceFor(cfg, team);
      let tok: K8sObject | null = null;
      try {
        tok = await k8s.get('Secret', appsNs, 'deployer-token');
      } catch (err) {
        this.log.warn(`hermes-pods: cannot read the deployer token of ${appsNs}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const data = (tok?.data ?? {}) as Record<string, string>;
      const token = b64(data['token']);
      const ca = b64(data['ca.crt']);
      if (token !== '' && ca !== '') {
        const { logins: targets, failed } = await this.deployTargetLogins(team);
        // a read error on a deploy target is usually momentary: keep the kubeconfig written last tick (it still has that context) and try again next tick
        const previous = failed ? await k8s.get('Secret', cfg.namespace, names.deployer).catch(() => null) : null;
        if (previous) this.log.warn(`hermes-pods: keeping the last deployer kubeconfig of ${team.slug} (a deploy target could not be read this tick)`);
        else deployerSecret = buildDeployerSecretFor(cfg, team, names, { token, caPem: ca, appsNamespace: appsNs, appsRouting: cfg.appsRouting, appUrlPattern: appUrlPattern(cfg, team), targets });
        withDeployer = true;
      } else {
        // No apps namespace (the team is not in hermesPods.appTeams): its deploy targets alone still make a kubeconfig.
        const { logins: targets, failed } = await this.deployTargetLogins(team);
        const ca = targets.find((t) => t.caPem)?.caPem ?? '';
        const previous = failed ? await k8s.get('Secret', cfg.namespace, names.deployer).catch(() => null) : null;
        if (previous) {
          this.log.warn(`hermes-pods: keeping the last deployer kubeconfig of ${team.slug} (a deploy target could not be read this tick)`);
          withDeployer = true;
        } else if (targets.length > 0 && ca !== '') {
          deployerSecret = buildDeployerSecretFor(cfg, team, names, { token: null, caPem: ca, appsNamespace: appsNs, targets });
          withDeployer = true;
        } else {
          this.log.warn(`hermes-pods: there is no ready deployer token in ${appsNs} and no deploy target (add the team to hermesPods.appTeams); the deployer bot of ${team.slug} has no kubeconfig`);
        }
      }
    }

    // an existing claim keeps the machine it is really on; a new one gets the machine chosen
    const stampOf = (claim: string): string | null => (claim in plan.stamp ? (plan.stamp[claim] ?? null) : node);
    // order matters only for readability: data first, then the Deployment that mounts it
    const objects: K8sObject[] = [
      // While a move is under way the claims are left alone (a claim that is being deleted must not be re-applied); the Secrets and the config below are applied as always.
      ...(moving
        ? []
        : [
            buildPvc(cfg, team, names.workspace, cfg.workspaceSize, stampOf(names.workspace)),
            buildPvc(cfg, team, names.home, cfg.homeSize, stampOf(names.home)),
          ]),
      buildKeySecret(cfg, team, names, apiKey),
      buildProfilesSecret(cfg, team, names, profiles, users),
      buildBotsConfigMap(withProjectRepos(cfg, projectRepos), team, names, users),
      ...(deployerSecret ? [deployerSecret] : []),
      buildService(cfg, team, names),
      buildDeployment(cfg, team, names, { replicas: users.length > 0 && !moving ? 1 : 0, withDeployer, node, moving, held: plan.held, proxy }),
    ];
    assertGatewayOnly(objects);
    for (const obj of objects) await k8s.apply(obj);
    if (moving && plan.stale.length > 0) await this.finishMove(team, names, plan.stale);

    const gatewayUrl = `http://${names.base}.${cfg.namespace}.svc:${GATEWAY_PORT}`;
    const announceKey = `${team.id}|${gatewayUrl}`;
    if (this.source.setManagedGateway && users.length > 0 && !this.announced.has(announceKey)) {
      await this.source.setManagedGateway(team.id, { baseUrl: gatewayUrl });
      this.announced.add(announceKey);
    }
    return { team: team.slug, pod: names.base, profiles: users.length, deployer: withDeployer, gatewayUrl, node, moving, held: plan.held };
  }

  /** The machine the team's pod is pinned to. A name that is not a label value is refused with a warning (the pod is then not pinned); a failed read fails the pass. */
  private async pinnedNode(team: Team): Promise<string | null> {
    const node = (await this.source.nodeForTeam?.(team.id)) ?? null;
    if (node === null) return null;
    if (!isNodeLabelValue(node)) {
      this.log.warn(`hermes-pods: ${team.slug}: the machine chosen for this team's runner is not a usable node name, so the pod is not pinned`);
      return null;
    }
    return node;
  }

  /**
   * Decides, for one team, which machine the pod is pinned to and whether its volumes are moved. The volumes are deleted only by a move an admin confirmed, so every other
   * change of the machine chosen for the team (Make default, Enable or Disable, the Teams list, a second pod runner) changes nothing that holds data:
   *  - no volume claims yet (a new pod): the pod is pinned to the machine chosen;
   *  - the volumes are on the machine chosen (or tied to no machine): the pod is pinned to it;
   *  - the volumes are on another machine and the admin has not confirmed the move to this machine within the confirmation window: HELD. The pod stays pinned to the
   *    machine its volumes are on and keeps running, the Deployment says `move-held`, and nothing is deleted;
   *  - confirmed (or already under way): the machine must be an existing, Ready node the admin may choose; then the pod stops, and both volumes are deleted once no pod of the
   *    team is left. If the machine cannot be verified, a move not yet started is held, and one under way stays stopped; no volume is deleted.
   */
  private async planNode(team: Team, names: Names): Promise<NodePlan> {
    const wanted = await this.pinnedNode(team);
    const claimNames = [names.workspace, names.home];
    const claims = new Map<string, K8sObject | null>();
    for (const n of claimNames) claims.set(n, await this.k8s.get('PersistentVolumeClaim', this.cfg.namespace, n));
    const existing = claimNames.filter((n) => claims.get(n) != null);

    let nodeObjects: K8sObject[] | null | undefined;
    const nodesNow = async (): Promise<K8sObject[] | null> => {
      if (nodeObjects !== undefined) return nodeObjects;
      try {
        nodeObjects = (await this.k8s.listNodes?.()) ?? null;
      } catch (err) {
        this.log.warn(`hermes-pods: ${team.slug}: cannot list the cluster's nodes: ${err instanceof Error ? err.message : String(err)}`);
        nodeObjects = null;
      }
      return nodeObjects;
    };

    // where each existing claim really is (by hostname)
    const sites = new Map<string, { node: string | null; unknown: boolean }>();
    const lookup = existing.some((n) => needsNodeLookup(claims.get(n) ?? null)) ? await nodesNow() : null;
    for (const n of existing) sites.set(n, volumeSite(claims.get(n) ?? null, lookup));
    // a claim stays stamped with the machine it is really on; one with no machine known is stamped with the chosen machine only if nothing ties it elsewhere
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
      this.log.info(`hermes-pods: ${team.slug}: the machine chosen for this team changed and its volumes are on another machine; nothing is moved until an admin confirms the move`);
      return hold;
    }
    const why = await this.targetProblem(wanted, nodesNow);
    if (why !== null) {
      this.log.warn(`hermes-pods: ${team.slug}: not moving the pod's volumes: ${why}`);
      // a move not yet started leaves the pod running; one under way keeps it stopped, and in both cases no volume is deleted
      return underWay ? { node: wanted, stamp, moving: true, held: null, stale: [] } : hold;
    }
    return { node: wanted, stamp, moving: true, held: null, stale: existing };
  }

  /** Why `node` is not a place to move volumes to right now, or null when it is an existing, Ready node the admin may choose. */
  private async targetProblem(node: string, nodesNow: () => Promise<K8sObject[] | null>): Promise<string | null> {
    const allowed = this.cfg.allowedNodes ?? [];
    if (allowed.length > 0 && !allowed.includes(node)) return 'the machine is not on the list of machines an admin may choose (botRunners.allowedNodes)';
    const objects = await nodesNow();
    if (objects === null) return "the cluster's nodes cannot be read, so the machine cannot be checked";
    const found = objects.map(toClusterNode).find((n) => n?.name === node);
    if (!found) return 'the machine is not a node of this cluster';
    if (!found.ready) return 'the machine is not Ready';
    return null;
  }

  /**
   * Second half of a move. The pod has been scaled to zero above; once no pod of the team is left (a stopping pod still holds its volumes) both claims are deleted, and
   * the next pass makes them new on the chosen machine and starts the pod. Secrets, the ConfigMap and the Service are never touched, so the pod's gateway key stays.
   * Everything on the two volumes is lost: the bots' working copies and repositories, the profiles' state and sessions (the repositories of record are cloned again).
   * A claim is deleted only if it carries this team's id label; if either does not, neither is deleted. The two go together: one left behind would tie the pod to the old machine.
   */
  private async finishMove(team: Team, names: Names, claimNames: readonly string[]): Promise<void> {
    const pods = await this.k8s.list('Pod', this.cfg.namespace, `manythreads.io/pod=${names.base}`);
    if (pods.length > 0) {
      this.log.info(`hermes-pods: ${team.slug}: moving the pod; waiting for it to stop before its volumes are recreated`);
      return;
    }
    const claims: K8sObject[] = [];
    for (const name of claimNames) {
      const claim = await this.k8s.get('PersistentVolumeClaim', this.cfg.namespace, name);
      if (!claim) continue;
      if (claim.metadata.labels?.['manythreads.io/team-id'] !== team.id) {
        this.log.warn(`hermes-pods: ${team.slug}: the volume claim ${name} does not carry this team's id, so no volume is deleted`);
        return;
      }
      claims.push(claim);
    }
    for (const claim of claims) if (!isTerminating(claim)) await this.k8s.delete('PersistentVolumeClaim', this.cfg.namespace, claim.metadata.name);
    this.log.info(`hermes-pods: ${team.slug}: the volumes of the pod are being recreated on the chosen machine`);
  }

  /**
   * One pass: every team in `teams` (those with managed bots), and a scale-down to zero profiles for any pod this controller made for a team that
   * no longer has any. Returns the per-team results; a team that fails is logged and does not stop the others.
   */
  async reconcileAll(teams: readonly Team[]): Promise<TeamResult[]> {
    const results: TeamResult[] = [];
    const wanted = new Set(teams.map((t) => t.id));
    for (const team of teams) {
      try {
        results.push(await this.reconcileTeam(team));
      } catch (err) {
        this.log.warn(`hermes-pods: team ${team.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const pods = await this.k8s.list('Deployment', this.cfg.namespace, 'app.kubernetes.io/component=hermes-pod,app.kubernetes.io/managed-by=manythreads-hermes-pods');
      for (const d of pods) {
        const id = d.metadata.labels?.['manythreads.io/team-id'];
        const slug = d.metadata.labels?.['manythreads.io/team'];
        if (!id || !slug || wanted.has(id)) continue;
        const replicas = (d.spec as { replicas?: number } | undefined)?.replicas ?? 0;
        // a pod stopped for a move (or held) still needs a pass to finish or clear it
        if (replicas === 0 && d.metadata.annotations?.[MOVING_ANNOTATION] === undefined && d.metadata.annotations?.[MOVE_HELD_ANNOTATION] === undefined) continue;
        try {
          results.push(await this.reconcileTeam({ id, slug }, []));
        } catch (err) {
          this.log.warn(`hermes-pods: scaling down ${d.metadata.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      this.log.warn(`hermes-pods: listing pods: ${err instanceof Error ? err.message : String(err)}`);
    }
    return results;
  }
}

export { botSlugOf, labelsFor };
