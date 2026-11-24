import { definePlugin, type BotRunnersProvider, type ClaudePodsProvider, type DeployKubeconfigProvider, type PluginContext, type PluginLogger, type PodAgent } from '@manythreads/sdk';
import { HttpK8s, confirmMark, type K8s, type K8sObject, type ProjectRepo } from '@manythreads/sdk/pods';
import { configFrom, type ClaudePodConfig } from './config.ts';
import { Reconciler, signOutBridge, type RunnerSource } from './reconcile.ts';
import { AGENTS, BRIDGE_PORT, COMPONENT, labelsFor, MANAGED_BY, namesFor, type PodRunner } from './render.ts';

export { Reconciler, stateFor } from './reconcile.ts';
export { configFrom } from './config.ts';
export { buildBridgeConfig, buildDeployment, namesFor, podBaseFor, runnerForTeam, slugForRunner, profileName } from './render.ts';
export type { PodRunner } from './render.ts';

export const FIELD_MANAGER = MANAGED_BY;
const FIRST_PASS_DELAY_MS = 20_000;
/** The events that change which repositories a runner's pod must have. */
export const PROJECT_EVENTS = ['project.project.created', 'project.project.updated', 'project.project.deleted'] as const;
/** How long after a project event the controller runs a pass (a burst of events makes one pass). A clone then follows within the sync step's own few seconds. */
export const WAKE_DELAY_MS = 1_000;

/**
 * A wake-up with a short delay: calling it again while one is waiting changes nothing, so a burst of events costs one pass. Returns the function that asks for the pass.
 * `run` is called once the delay is over; its failures are the caller's to catch.
 */
export function createWake(run: () => void, delayMs: number = WAKE_DELAY_MS, timers: { set: typeof setTimeout } = { set: setTimeout }): () => void {
  let waiting = false;
  return () => {
    if (waiting) return;
    waiting = true;
    const t = timers.set(() => {
      waiting = false;
      run();
    }, delayMs);
    (t as { unref?: () => void }).unref?.();
  };
}

/**
 * claude-pods: the controller that gives every team of every Claude Code runner and every Codex runner (a workspace admin made it on the Runners page) its own pod, `claude-<runner>-<team>` or
 * `codex-<runner>-<team>`, in the pods namespace; the runner's sign-in (its state volume) is shared by its team pods.
 * It reads the runner list and the bots placed on each from the `bot.runners` provider, writes the bridge's configuration, and keeps the pod, its two volumes and its
 * Service in step. It stops the pod (replicas 0) while there is no sign-in file, the runner is off or no bot is placed on it, and never deletes a volume except in a move an admin
 * confirmed. Runs only where the chart turned it on (MANYTHREADS_CLAUDE_PODS=1). docs/plugins/claude-pods.md.
 */
export default definePlugin({
  manifest: {
    name: 'claude-pods',
    version: '0.1.0',
    kind: 'server',
    // `provider.claude.pods`: where each runner's pod stands, and the admin's confirmation of a move (read by bot-runners for the Runners page).
    extends: ['provider.claude.pods', 'event.subscribe'],
    // A project that is added, moved or removed wakes the controller within seconds (the repository list reaches the pod's bridge instead of waiting for the next pass).
    events: { emits: [], consumes: [...PROJECT_EVENTS] },
    dependsOn: ['bot-runners', 'projects', 'teams'],
  },
  register(ctx) {
    startController(ctx, process.env);
  },
});

function makeLogger(): PluginLogger {
  return { info: (m) => console.log(m), warn: (m) => console.warn(m) };
}

/** The platform side of the controller: the runner list through the `bot.runners` provider, the teams' projects from the projects table. */
export function platformSource(ctx: PluginContext): RunnerSource {
  const runnersProvider = (): BotRunnersProvider => {
    const p = ctx.providers.get<BotRunnersProvider>('bot.runners');
    if (!p) throw new Error('the bot.runners provider is not loaded (bot-runners)');
    return p;
  };
  return {
    // Both kinds in one list. If either question fails the whole pass fails: a pass that saw only one kind would take the other kind's pods for runners that are gone.
    runners: async (): Promise<PodRunner[]> => {
      const p = runnersProvider();
      const [claude, codex] = await Promise.all([p.podRunners({ kind: 'claude_cli' }), p.podRunners({ kind: 'codex_cli' })]);
      return [...claude.map((r): PodRunner => ({ ...r, agent: 'claude' })), ...codex.map((r): PodRunner => ({ ...r, agent: 'codex' }))];
    },
    report: (state) => runnersProvider().reportPodState(state),
    // the deployer's login, made by the Hermes pods (P26-11); without that plugin's controller there is none and a deployer bot of an agent pod gets no kubeconfig
    deployerKubeconfig: async (team) => ctx.providers.get<DeployKubeconfigProvider>('deploy.kubeconfig')?.ensure({ team }) ?? null,
    publishersForTeams: (teamIds) =>
      ctx.db.system(async (tx) => {
        // the same question the Hermes pods ask: which bots of these teams hold a tasks.pull_request grant
        const res = await tx.query<{ team_slug: string; bot_slug: string }>(
          `SELECT DISTINCT t.slug AS team_slug, b.slug AS bot_slug
             FROM app.capability_grants g
             JOIN app.actors a ON a.id = g.actor_id AND a.kind = 'bot'
             JOIN app.bots b ON b.id = a.ref_id AND b.team_id = g.team_id AND b.status = 'active'
             JOIN app.teams t ON t.id = g.team_id
            WHERE g.team_id = ANY($1::uuid[]) AND g.capability = 'tasks.pull_request'`,
          [[...teamIds]],
        );
        return res.rows.map((r) => ({ teamSlug: r.team_slug, botSlug: r.bot_slug }));
      }),
    reposForTeams: (teamIds) =>
      ctx.db.system(async (tx) => {
        const res = await tx.query<{ team_slug: string; name: string; repo_url: string; default_branch: string }>(
          'SELECT t.slug AS team_slug, p.name, p.repo_url, p.default_branch FROM app.projects p JOIN app.teams t ON t.id = p.team_id WHERE p.team_id = ANY($1::uuid[]) ORDER BY t.slug, p.name',
          [[...teamIds]],
        );
        return res.rows.map((r): ProjectRepo & { teamSlug: string } => ({ teamSlug: r.team_slug, name: r.name, origin: r.repo_url, branch: r.default_branch }));
      }),
  };
}

/** What the bridge's sign-in check answers; anything else (or no answer) reads as `unreachable`. The words are the bridge's own, in tools/agent-bridge/src/signin.ts. */
const CHECK_RESULTS = ['ok', 'rejected', 'expired', 'no_scope', 'limit'] as const;

export function providerFor(reconciler: () => Reconciler, k8s: () => K8s, cfg: ClaudePodConfig, now: () => number = Date.now, doFetch: typeof fetch = fetch): ClaudePodsProvider {
  const keyOf = async (secretName: string): Promise<string> => {
    const secret = await k8s().get('Secret', cfg.namespace, secretName);
    return secret?.data ? Buffer.from(String((secret.data as Record<string, string>)['api-key'] ?? ''), 'base64').toString('utf8') : '';
  };
  /** A runner's team pods, by name: its Deployments that carry a team (the old single pod, which carries none, is not one). */
  const teamPods = async (runnerName: string, agent: PodAgent): Promise<K8sObject[]> => {
    const prefix = `${AGENTS[agent].prefix}-`;
    const deps = await k8s().list('Deployment', cfg.namespace, `app.kubernetes.io/component=${COMPONENT},app.kubernetes.io/managed-by=${MANAGED_BY},manythreads.io/runner=${runnerName}`);
    return deps.filter((d) => d.metadata.name.startsWith(prefix) && d.metadata.labels?.['manythreads.io/team-id'] !== undefined).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  };
  const bridge: ClaudePodsProvider['bridge'] = async ({ runnerName, agent = 'claude', teamSlug }) => {
    // Test seam (P19-12): a test server (NODE_ENV=test) may point every bridge at one stand-in that speaks the bridge's protocol, since no pod and no cluster DNS exist in a stack.
    // Both variables must be set; in a real install neither is, and a NODE_ENV other than `test` ignores them.
    const standInUrl = process.env['NODE_ENV'] === 'test' ? (process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL'] ?? '') : '';
    const standInKey = process.env['MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY'] ?? '';
    if (standInUrl !== '' && standInKey !== '') return { address: standInUrl, key: standInKey };
    const addressOf = (base: string): string => `http://${base}.${cfg.namespace}.svc:${BRIDGE_PORT}`;
    if (teamSlug !== undefined) {
      // a run goes to the pod of its own team
      const names = namesFor(runnerName, agent, teamSlug);
      const key = await keyOf(names.key);
      return key === '' ? null : { address: addressOf(names.base), key };
    }
    // The runner's sign-in is shared by its pods: the first running pod by name answers, and it is the same one for every step of one sign-in while it runs.
    const pods = await teamPods(runnerName, agent);
    const running: K8sObject[] = [];
    for (const d of pods) if ((await k8s().list('Pod', cfg.namespace, `manythreads.io/pod=${d.metadata.name}`)).some((p) => String((p.status as { phase?: string } | undefined)?.phase) === 'Running')) running.push(d);
    for (const d of [...running, ...pods.filter((p) => !running.includes(p))]) {
      const key = await keyOf(`${d.metadata.name}-key`);
      if (key !== '') return { address: addressOf(d.metadata.name), key };
    }
    return null;
  };
  return {
    id: 'claude.pods',
    podPlacements: (q) => reconciler().placements(q.runnerIds),
    async putCredentials({ runnerName, runnerId, bytes, uploadId, agent }) {
      const names = namesFor(runnerName, agent);
      // The bytes go in exactly as they came. The controller never applies this Secret again, so a refreshed copy the keeper writes back is not overwritten.
      await k8s().apply({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: names.credentials, namespace: cfg.namespace, labels: labelsFor({ id: runnerId, name: runnerName }) },
        type: 'Opaque',
        data: { [names.file]: Buffer.from(bytes).toString('base64'), 'upload-id': Buffer.from(uploadId).toString('base64') },
      });
    },
    async removeCredentials({ runnerName, agent }) {
      const names = namesFor(runnerName, agent);
      // The login also lives in the pod's state volume (the copy the tool renews; the keeper copies it back to the Secret). Deleting only the Secret would leave a working login on that volume for good,
      // so the state claim goes first (its volume is freed once the pod stops, which the controller does as soon as the Secret is gone); the claim is made again, empty, for the next sign-in.
      // A failure here stops before the Secret is touched, so "nothing was changed" stays true. The work claim holds only public clones and stays.
      await k8s().delete('PersistentVolumeClaim', cfg.namespace, names.state);
      await k8s().delete('Secret', cfg.namespace, names.credentials);
    },
    async removeTeamSignins({ runnerId, teamId }) {
      // only claims this controller made for the runner (its id label) and, with a team, that team's (its id label): a slug used again never names another team's volume
      const claims = (await k8s().list('PersistentVolumeClaim', cfg.namespace, `app.kubernetes.io/managed-by=${MANAGED_BY},manythreads.io/runner-id=${runnerId}`)).filter(
        (c) => c.metadata.name.endsWith('-signin') && (teamId === undefined || c.metadata.labels?.['manythreads.io/team-id'] === teamId),
      );
      for (const c of claims) {
        // signed out for real first, through the team pod's bridge while it still runs (a runner or a team going away); best effort, then the volume goes
        const base = c.metadata.name.replace(/-signin$/, '');
        const agent: PodAgent = base.startsWith(`${AGENTS.codex.prefix}-`) ? 'codex' : 'claude';
        const running = (await k8s().list('Pod', cfg.namespace, `manythreads.io/pod=${base}`)).some((p) => String((p.status as { phase?: string } | undefined)?.phase) === 'Running');
        const key = running ? await keyOf(`${base}-key`).catch(() => '') : '';
        if (key !== '') await signOutBridge(doFetch, `http://${base}.${cfg.namespace}.svc:${BRIDGE_PORT}`, key, AGENTS[agent].profileAgent);
        await k8s().delete('PersistentVolumeClaim', cfg.namespace, c.metadata.name);
      }
      return claims.length;
    },
    bridge,
    async checkSignin({ runnerName, agent, teamSlug }) {
      try {
        // the sign-in is the runner's: any running pod of it can say; a team's own sign-in (P35-10) only that team's pod
        const target = await bridge({ runnerName, ...(agent !== undefined ? { agent } : {}), ...(teamSlug !== undefined ? { teamSlug } : {}) });
        if (!target) return 'unreachable';
        const res = await doFetch(`${target.address}/v1/signin/check`, { method: 'POST', headers: { authorization: `Bearer ${target.key}` }, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) return 'unreachable';
        const body = (await res.json()) as { result?: unknown };
        return (CHECK_RESULTS as readonly unknown[]).includes(body.result) ? (body.result as (typeof CHECK_RESULTS)[number]) : 'unreachable';
      } catch {
        return 'unreachable';
      }
    },
    async confirmMove({ runnerId, node }) {
      // all of the runner's claims: the shared state volume and every team's work volume move together
      const claims = (await k8s().list('PersistentVolumeClaim', cfg.namespace, `app.kubernetes.io/managed-by=${MANAGED_BY},manythreads.io/runner-id=${runnerId}`)).filter((c) => /-(state|signin|work)$/.test(c.metadata.name));
      for (const c of claims) await k8s().annotate?.('PersistentVolumeClaim', cfg.namespace, c.metadata.name, { 'manythreads.io/move-confirmed': node === null ? null : confirmMark(node, now()) });
      return claims.length;
    },
  };
}

export function startController(ctx: PluginContext, env: NodeJS.ProcessEnv): void {
  // Test seam: with NODE_ENV=test, MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL points the controller at a local double of the Kubernetes API. Ignored everywhere else.
  const testUrl = env['NODE_ENV'] === 'test' ? (env['MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL'] ?? '').trim() : '';
  if (env['MANYTHREADS_CLAUDE_PODS'] !== '1' && testUrl === '') return;
  const log = makeLogger();
  const cfg = configFrom(env);
  const intervalMs = Math.max(5, Number(env['MANYTHREADS_CLAUDE_PODS_INTERVAL_SECONDS'] ?? '30') || 30) * 1000;

  let k8s: K8s | null = null;
  let reconciler: Reconciler | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const client = (): K8s => (k8s ??= testUrl !== '' ? new HttpK8s({ baseUrl: testUrl, token: 'test', fieldManager: FIELD_MANAGER }) : HttpK8s.inCluster(env, FIELD_MANAGER));
  const ensure = (): Reconciler => (reconciler ??= new Reconciler(client(), cfg, platformSource(ctx), log));

  // The provider exists only where the controller does, so the Runners page can tell "Claude pods are not turned on here" from a working install.
  ctx.providers.register('claude.pods', providerFor(ensure, client, cfg));

  // The test seam registers the provider only; the loop runs where the chart turned the controller on.
  if (env['MANYTHREADS_CLAUDE_PODS'] !== '1') return;
  const tick = (): void => {
    serialized(async () => {
      for (const r of await ensure().reconcileAll()) log.info(`claude-pods: ${r.pod} ok (${r.state}, replicas ${r.replicas})`);
    }).catch((err: unknown) => log.warn(`claude-pods: pass failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs).unref();
  }, FIRST_PASS_DELAY_MS).unref();
  // a project change runs a pass soon, so the repository list reaches the pod in seconds
  const wake = createWake(tick);
  for (const type of PROJECT_EVENTS) ctx.events.subscribe(type, async () => wake());
}

export { namesFor as claudePodNames };
