import { randomBytes } from 'node:crypto';
import type { GatewayProfileSpec, PluginLogger } from '@manythreads/sdk';
import type { K8s, K8sObject } from './k8s.ts';
import { withProjectRepos, type ProjectRepo } from './project-repos.ts';
import {
  GATEWAY_PORT,
  appUrlPattern,
  appsNamespaceFor,
  assignUsers,
  botSlugOf,
  buildBotsConfigMap,
  buildDeployerKubeconfig,
  buildDeployerSecret,
  buildDeployment,
  buildKeySecret,
  buildProfilesSecret,
  buildPvc,
  buildService,
  type DeployTargetLogin,
  labelsFor,
  namesFor,
  type Names,
  type PodConfig,
  type Team,
} from './render.ts';

/** What the controller needs from the platform: a team's profiles and a place to tell where the team's pod answers. */
export interface ProfileSource {
  profilesForTeam(teamId: string): Promise<GatewayProfileSpec[]>;
  /** The team's projects as repositories of record (name and https address); absent in the test-only static mode. */
  reposForTeam?(teamId: string): Promise<ProjectRepo[]>;
  /** Absent in the test-only static mode. */
  setManagedGateway?(teamId: string, input: { baseUrl: string }): Promise<void>;
}

export interface TeamResult {
  team: string;
  pod: string;
  profiles: number;
  deployer: boolean;
  gatewayUrl: string;
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
  ) {}

  /** The names for a team: plain `hermes-<slug>` unless another team's pod already holds that name. */
  private async resolveNames(team: Team): Promise<Names> {
    const plain = namesFor(team);
    const existing = await this.k8s.get('Deployment', this.cfg.namespace, plain.base);
    const owner = existing?.metadata.labels?.['manythreads.io/team-id'];
    return existing && owner !== undefined && owner !== team.id ? namesFor(team, true) : plain;
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
    const profiles = profilesOverride ?? (await this.source.profilesForTeam(team.id));
    const names = await this.resolveNames(team);

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

    const users = assignUsers(profiles, existingUids, cfg.deployerBot);
    const projectRepos = (await this.source.reposForTeam?.(team.id)) ?? [];

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
        else deployerSecret = buildDeployerSecret(cfg, team, names, buildDeployerKubeconfig({ token, caPem: ca, appsNamespace: appsNs, appsRouting: cfg.appsRouting, appUrlPattern: appUrlPattern(cfg, team), targets }));
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
          deployerSecret = buildDeployerSecret(cfg, team, names, buildDeployerKubeconfig({ token: null, caPem: ca, appsNamespace: appsNs, targets }));
          withDeployer = true;
        } else {
          this.log.warn(`hermes-pods: there is no ready deployer token in ${appsNs} and no deploy target (add the team to hermesPods.appTeams); the deployer bot of ${team.slug} has no kubeconfig`);
        }
      }
    }

    // order matters only for readability: data first, then the Deployment that mounts it
    const objects: K8sObject[] = [
      buildPvc(cfg, team, names.workspace, cfg.workspaceSize),
      buildPvc(cfg, team, names.home, cfg.homeSize),
      buildKeySecret(cfg, team, names, apiKey),
      buildProfilesSecret(cfg, team, names, profiles, users),
      buildBotsConfigMap(withProjectRepos(cfg, projectRepos), team, names, users),
      ...(deployerSecret ? [deployerSecret] : []),
      buildService(cfg, team, names),
      buildDeployment(cfg, team, names, { replicas: users.length > 0 ? 1 : 0, withDeployer }),
    ];
    for (const obj of objects) await k8s.apply(obj);

    const gatewayUrl = `http://${names.base}.${cfg.namespace}.svc:${GATEWAY_PORT}`;
    const announceKey = `${team.id}|${gatewayUrl}`;
    if (this.source.setManagedGateway && users.length > 0 && !this.announced.has(announceKey)) {
      await this.source.setManagedGateway(team.id, { baseUrl: gatewayUrl });
      this.announced.add(announceKey);
    }
    return { team: team.slug, pod: names.base, profiles: users.length, deployer: withDeployer, gatewayUrl };
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
        if (replicas === 0) continue;
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
