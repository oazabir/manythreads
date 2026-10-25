import { definePlugin, type GatewayProfileSpec, type HermesProfilesProvider, type PluginContext, type PluginLogger } from '@manythreads/sdk';
import { configFrom } from './config.ts';
import { HttpK8s, type K8s } from './k8s.ts';
import { Reconciler, type ProfileSource } from './reconcile.ts';
import type { ProjectRepo } from './project-repos.ts';
import type { Team } from './render.ts';

export { Reconciler } from './reconcile.ts';
export { HttpK8s } from './k8s.ts';
export { configFrom } from './config.ts';

/**
 * hermes-pods: the controller that gives every team with managed bots its own Hermes pod (`hermes-<team>`) in this namespace. It reads the
 * bots' profiles from the `hermes.profiles` provider (runtime-hermes), writes them into the pod's Secret, and keeps the pod, its volumes
 * and its Service in step. Runs only where the chart turned it on (MANYTHREADS_HERMES_PODS=1). docs/plugins/hermes-pods.md.
 */
export default definePlugin({
  manifest: {
    name: 'hermes-pods',
    version: '0.1.0',
    kind: 'server',
    extends: [],
    events: { emits: [], consumes: [] },
    dependsOn: ['teams', 'projects'],
  },
  register(ctx) {
    startController(ctx, process.env);
  },
});

const FIRST_PASS_DELAY_MS = 20_000;

/** Teams with at least one active bot placed on the managed gateway. */
async function teamsWithManagedBots(ctx: PluginContext): Promise<Team[]> {
  return ctx.db.system(async (tx) => {
    const res = await tx.query<{ id: string; slug: string }>(
      `SELECT DISTINCT t.id, t.slug
         FROM app.teams t JOIN app.bots b ON b.team_id = t.id
        WHERE t.archived_at IS NULL AND b.status = 'active' AND b.placement -> 'gateway' ->> 'connection' = 'managed'
        ORDER BY t.slug`,
    );
    return res.rows;
  });
}

/** The team's projects (the projects plugin's table) as repositories of record. */
async function projectReposOf(ctx: PluginContext, teamId: string): Promise<ProjectRepo[]> {
  return ctx.db.system(async (tx) => {
    const res = await tx.query<{ name: string; repo_url: string; default_branch: string }>(
      'SELECT name, repo_url, default_branch FROM app.projects WHERE team_id = $1::uuid ORDER BY name',
      [teamId],
    );
    return res.rows.map((r) => ({ name: r.name, origin: r.repo_url, branch: r.default_branch }));
  });
}

async function teamById(ctx: PluginContext, id: string): Promise<Team | null> {
  return ctx.db.system(async (tx) => {
    const res = await tx.query<{ id: string; slug: string }>('SELECT id, slug FROM app.teams WHERE id = $1::uuid', [id]);
    return res.rows[0] ?? null;
  });
}

/** Test/demo only: `MANYTHREADS_HERMES_PODS_STATIC` = {"<team slug>": [GatewayProfileSpec, ...]} stands in for the platform's profiles. */
export function staticSource(raw: string): { teams: Team[]; source: ProfileSource } {
  const doc = JSON.parse(raw) as Record<string, GatewayProfileSpec[]>;
  const teams = Object.keys(doc).map((slug) => ({ id: `static-${slug}`, slug }));
  return { teams, source: { profilesForTeam: async (id) => doc[id.replace(/^static-/, '')] ?? [] } };
}

export function startController(ctx: PluginContext, env: NodeJS.ProcessEnv): void {
  if (env['MANYTHREADS_HERMES_PODS'] !== '1') return;
  const log = makeLogger();
  const cfg = configFrom(env);
  const intervalMs = Math.max(5, Number(env['MANYTHREADS_HERMES_PODS_INTERVAL_SECONDS'] ?? '30') || 30) * 1000;
  const staticRaw = env['MANYTHREADS_HERMES_PODS_STATIC'];
  if (staticRaw && env['NODE_ENV'] === 'production') {
    makeLogger().warn('hermes-pods: MANYTHREADS_HERMES_PODS_STATIC is test-only and is refused in production; the controller is not started');
    return;
  }
  const fixed = staticRaw ? staticSource(staticRaw) : null;

  let k8s: K8s | null = null;
  let reconciler: Reconciler | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const ensure = (): Reconciler | null => {
    if (reconciler) return reconciler;
    try {
      k8s = HttpK8s.inCluster(env);
    } catch (err) {
      log.warn(`hermes-pods: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const provider = (): HermesProfilesProvider | undefined => ctx.providers.get<HermesProfilesProvider>('hermes.profiles');
    const source: ProfileSource = fixed
      ? fixed.source
      : {
          profilesForTeam: async (id) => {
            const p = provider();
            if (!p) throw new Error('the hermes.profiles provider is not loaded (runtime-hermes)');
            return p.profilesForTeam(id);
          },
          reposForTeam: (id) => projectReposOf(ctx, id),
          setManagedGateway: async (id, input) => {
            await provider()?.setManagedGateway(id, input);
          },
        };
    reconciler = new Reconciler(k8s, cfg, source, log);
    if (!fixed) {
      provider()?.onChange(({ teamId }) => {
        setTimeout(() => {
          void serialized(async () => {
            const team = await teamById(ctx, teamId);
            if (team && reconciler) await reconciler.reconcileTeam(team);
          }).catch((err: unknown) => log.warn(`hermes-pods: change of ${teamId}: ${err instanceof Error ? err.message : String(err)}`));
        }, 2000).unref();
      });
    }
    return reconciler;
  };

  const pass = async (): Promise<void> => {
    const r = ensure();
    if (!r) return;
    const teams = fixed ? fixed.teams : await teamsWithManagedBots(ctx);
    const results = await serialized(() => r.reconcileAll(teams));
    for (const res of results) log.info(`hermes-pods: ${res.pod} ok (${res.profiles} profile(s), deployer ${res.deployer ? 'yes' : 'no'})`);
  };

  const tick = (): void => {
    pass().catch((err: unknown) => log.warn(`hermes-pods: pass failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs).unref();
  }, FIRST_PASS_DELAY_MS).unref();
}

function makeLogger(): PluginLogger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
}
