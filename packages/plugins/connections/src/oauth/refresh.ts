import type { PluginContext } from '@manythreads/sdk';
import type { PersonProviderId } from '@manythreads/shared';
import { providerDef } from './providers.ts';
import { accessTokenFor, ConnectionProblem, type OAuthDeps } from './store.ts';

// Renewing sign-ins by job (PLAN P16-02). A provider's access token lives for about an hour. Without this job the first call after it ran out would pay for the renewal
// (and, with a provider that rotates refresh tokens, a person's bot run would be the one to find the sign-in dead). Every ten minutes the job renews the sign-ins whose
// access token ends within the next twenty, one at a time, through the same function a tool call uses (`accessTokenFor`), so a renewal is held to the same rules: the
// connection's row is locked, the new refresh token (rotation) replaces the old in the same transaction, and a provider that refuses it for good turns the connection
// off and tells the person once. It reads and writes no token itself.

export const REFRESH_QUEUE = 'connections.oauth_refresh';
export const REFRESH_CRON = '*/10 * * * *';
/** A sign-in whose access token ends within this long is renewed by the job. Twice the job's period, so one missed run costs nothing. */
export const REFRESH_WINDOW_MS = 20 * 60_000;
/** The most sign-ins one run renews; the rest wait for the next run. Ones that keep failing sort last, so they cannot starve healthy ones. */
export const REFRESH_BATCH = 100;

type Due = { id: string; workspace_id: string; provider: string };

/** Renews what is due now, for every workspace. Returns how many were renewed and how many did not work (the reasons are on each connection, not here). */
export async function renewDueSignIns(deps: OAuthDeps, options: { windowMs?: number; batch?: number } = {}): Promise<{ renewed: number; failed: number }> {
  const windowMs = options.windowMs ?? REFRESH_WINDOW_MS;
  const due = await deps.db.system(async (tx) =>
    (
      await tx.query<Due>(
        `SELECT c.id, c.workspace_id, o.provider
           FROM app.connection_oauth o JOIN app.connections c ON c.id = o.connection_id
          WHERE o.state = 'ok' AND c.status = 'enabled' AND o.access_expires_at IS NOT NULL AND o.access_expires_at <= $1
          ORDER BY o.failures, o.access_expires_at LIMIT $2`,
        [new Date(deps.now().getTime() + windowMs), options.batch ?? REFRESH_BATCH],
      )
    ).rows,
  );
  let renewed = 0;
  let failed = 0;
  for (const row of due) {
    const def = providerDef(row.provider);
    if (!def?.refreshes) continue;
    try {
      await accessTokenFor(deps, { id: row.id, workspaceId: row.workspace_id, provider: def.id as PersonProviderId }, { skewMs: windowMs });
      renewed += 1;
    } catch (err) {
      // a dead sign-in was marked (and the person told) inside accessTokenFor; a provider that was down was counted on the connection. Neither is an error of the job.
      if (!(err instanceof ConnectionProblem)) throw err;
      failed += 1;
    }
  }
  return { renewed, failed };
}

export function registerRefreshJob(ctx: PluginContext, deps: OAuthDeps): void {
  ctx.jobs.register(
    REFRESH_QUEUE,
    async (_payload, _unusable, job) => {
      const { renewed, failed } = await renewDueSignIns(deps);
      // counts only: never a token, an address or a provider's text
      if (renewed + failed > 0) job.log.info(`connections: ${String(renewed)} sign-in(s) renewed, ${String(failed)} not`);
    },
    { cron: REFRESH_CRON, maxAttempts: 1, concurrency: 1, detached: true },
  );
}
