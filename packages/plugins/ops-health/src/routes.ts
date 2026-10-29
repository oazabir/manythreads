import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, forbidden, json, route, type HttpResponse, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { OpsHealthResponse, getOpsHealthRoute, type OpsHealthCheck } from '@manythreads/shared';
import { recoverRoundsFrom, thresholdsFrom } from './config.ts';
import { evaluate } from './evaluate.ts';
import { HEALTH_STATE_KEY, parseState, type Measured, type Monitor } from './monitor.ts';
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from './prometheus.ts';

export const METRICS_PATH = '/metrics';

/** A token shorter than this is treated as not set: a short one can be guessed. */
export const MIN_TOKEN_LENGTH = 16;

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** The bearer credential of an `Authorization` header, or null. */
export function bearerOf(header: string | undefined): string | null {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

/** Equal without leaking, through timing, how much of a wrong token matched. */
export const tokenMatches = (given: string, expected: string): boolean => timingSafeEqual(digest(given), digest(expected));

/** The verdicts as the watcher last stored them for a workspace, applied to the numbers just taken (no write). */
async function checksFor(ctx: PluginContext, measured: Measured, env: NodeJS.ProcessEnv, workspaceId: string | null): Promise<OpsHealthCheck[]> {
  const prev = workspaceId ? parseState(await ctx.storage.get({ type: 'workspace', id: workspaceId }, HEALTH_STATE_KEY)) : {};
  return evaluate(measured.snapshot, thresholdsFrom(env), prev, ctx.runtime.now(), recoverRoundsFrom(env)).checks;
}

async function requireWorkspaceAdmin(tx: PluginTx): Promise<void> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.workspace_role() AS role')).rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only workspace admins can see system health.');
}

export function registerRoutes(ctx: PluginContext, monitor: Monitor, env: NodeJS.ProcessEnv = process.env): void {
  // `/metrics` for a monitoring system. Never public: with no token set the route does not exist (404), and without the right bearer token it
  // answers 401. The web pod's proxy does not forward this path, so it is reachable inside the cluster only.
  ctx.http.route({
    method: 'GET',
    path: METRICS_PATH,
    public: true,
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: async (req): Promise<HttpResponse> => {
      const expected = (process.env['MANYTHREADS_METRICS_TOKEN'] ?? '').trim();
      if (expected.length < MIN_TOKEN_LENGTH) throw new HttpError(404, 'not_found', 'Not found');
      const given = bearerOf(req.headers['authorization']);
      if (given === null || !tokenMatches(given, expected)) {
        return { status: 401, headers: { 'www-authenticate': 'Bearer realm="manythreads-metrics"' }, body: { error: { code: 'unauthenticated', message: 'A valid bearer token is required' } } };
      }
      const measured = await monitor.measure();
      const firstWorkspace = await ctx.db.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY id LIMIT 1')).rows[0]?.id ?? null);
      const checks = await checksFor(ctx, measured, env, firstWorkspace);
      return { status: 200, headers: { 'content-type': PROMETHEUS_CONTENT_TYPE, 'cache-control': 'no-store' }, body: renderPrometheus(measured.snapshot, checks, measured.sections) };
    },
  });

  // The same numbers for workspace owners and admins (the System health panel).
  ctx.http.route({
    method: getOpsHealthRoute.method,
    path: getOpsHealthRoute.path,
    schema: { response: OpsHealthResponse },
    handler: route(async (_req, tx) => {
      await requireWorkspaceAdmin(tx);
      const measured = await monitor.measure();
      const checks = await checksFor(ctx, measured, env, tx.actor.workspaceId);
      return json({ snapshot: measured.snapshot, checks });
    }),
  });
}
