import { definePlugin, type BotRunnersProvider, type ClaudePodsProvider, type PluginContext, type PluginLogger } from '@manythreads/sdk';
import { HttpK8s, confirmMark, type K8s, type ProjectRepo } from '@manythreads/sdk/pods';
import { configFrom, type ClaudePodConfig } from './config.ts';
import { Reconciler, type RunnerSource } from './reconcile.ts';
import { MANAGED_BY, namesFor } from './render.ts';

export { Reconciler, stateFor } from './reconcile.ts';
export { configFrom } from './config.ts';
export { buildBridgeConfig, buildDeployment, namesFor, slugForRunner, profileName } from './render.ts';

export const FIELD_MANAGER = MANAGED_BY;
const FIRST_PASS_DELAY_MS = 20_000;

/**
 * claude-pods: the controller that gives every Claude Code runner (a workspace admin made it on the Runners page) its own pod, `claude-<runner>`, in the pods namespace.
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
    extends: ['provider.claude.pods'],
    events: { emits: [], consumes: [] },
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
function platformSource(ctx: PluginContext): RunnerSource {
  const runnersProvider = (): BotRunnersProvider => {
    const p = ctx.providers.get<BotRunnersProvider>('bot.runners');
    if (!p) throw new Error('the bot.runners provider is not loaded (bot-runners)');
    return p;
  };
  return {
    runners: () => runnersProvider().podRunners({ kind: 'claude_cli' }),
    report: (state) => runnersProvider().reportPodState(state),
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

function providerFor(reconciler: () => Reconciler, k8s: () => K8s, cfg: ClaudePodConfig, now: () => number = Date.now): ClaudePodsProvider {
  return {
    id: 'claude.pods',
    podPlacements: (q) => reconciler().placements(q.runnerIds),
    async confirmMove({ runnerId, node }) {
      const claims = (await k8s().list('PersistentVolumeClaim', cfg.namespace, `app.kubernetes.io/managed-by=${MANAGED_BY},manythreads.io/runner-id=${runnerId}`)).filter((c) => /-(state|work)$/.test(c.metadata.name));
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

  const tick = (): void => {
    serialized(async () => {
      for (const r of await ensure().reconcileAll()) log.info(`claude-pods: ${r.pod} ok (${r.state}, replicas ${r.replicas})`);
    }).catch((err: unknown) => log.warn(`claude-pods: pass failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs).unref();
  }, testUrl !== '' ? 1_000 : FIRST_PASS_DELAY_MS).unref();
}

export { namesFor as claudePodNames };
