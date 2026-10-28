import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { HeartbeatRequest, HeartbeatResponse, ListPresenceResponse, PRESENCE_TTL_SECONDS, heartbeatRoute, listPresenceRoute } from '@manythreads/shared';
import { json, route } from './http.ts';

const iso = (d: Date): string => d.toISOString();

/** The signed-in person (people.id); a heartbeat belongs to a person, so a bot has none. */
export async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Presence belongs to people');
  return row.id;
}

/**
 * The heartbeat (PLAN A.3), moved here from the channels plugin: one UNLOGGED row per person in `app.presence` (channels migration 0003)
 * that expires by itself, because readers filter by `seen_at`. A client sends one every 30 s per open tab; 90 s without one is offline.
 */
export function registerHeartbeatRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...heartbeatRoute,
    schema: { body: HeartbeatRequest, response: HeartbeatResponse },
    // A heartbeat every 30 s per open tab; a few tabs and some retries stay far below this.
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { status = 'online' } = HeartbeatRequest.parse(req.body ?? {});
      await callerPerson(tx);
      const res = await tx.query<{ status: 'online' | 'away'; seen_at: Date }>(
        `INSERT INTO app.presence AS p (person_id, workspace_id, status, seen_at) VALUES (app.person_id(), app.workspace_id(), $1, now())
         ON CONFLICT (person_id) DO UPDATE SET status = EXCLUDED.status, seen_at = EXCLUDED.seen_at
         RETURNING p.status, p.seen_at`,
        [status],
      );
      const row = res.rows[0]!;
      return json(
        HeartbeatResponse.parse({ status: row.status, seenAt: iso(row.seen_at), expiresAt: iso(new Date(row.seen_at.getTime() + PRESENCE_TTL_SECONDS * 1000)) }),
      );
    }),
  });

  ctx.http.route({
    ...listPresenceRoute,
    schema: { response: ListPresenceResponse },
    handler: route(async (_req, tx) => {
      const res = await tx.query<{ person_id: string; status: string; seen_at: Date }>(
        `SELECT person_id, status, seen_at FROM app.presence
          WHERE workspace_id = app.workspace_id() AND seen_at > now() - make_interval(secs => $1) ORDER BY seen_at DESC LIMIT 1000`,
        [PRESENCE_TTL_SECONDS],
      );
      return json(ListPresenceResponse.parse({ people: res.rows.map((r) => ({ personId: r.person_id, status: r.status, seenAt: iso(r.seen_at) })) }));
    }),
  });
}
