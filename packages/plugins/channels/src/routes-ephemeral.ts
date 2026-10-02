import { HttpError } from '@manythreads/sdk';
import {
  HeartbeatRequest,
  HeartbeatResponse,
  ListPresenceResponse,
  ListTypingResponse,
  PRESENCE_TTL_SECONDS,
  TYPING_TTL_SECONDS,
  TypingPathParams,
  TypingRequest,
  TypingResponse,
  TypingStartedPush,
  WS_TYPING_STARTED,
  heartbeatRoute,
  listPresenceRoute,
  listTypingRoute,
  typingRoute,
} from '@manythreads/shared';
import { json, route } from './http.ts';
import { audience, myPersonId, requireChannel, requirePost, type Deps } from './service.ts';

/** A typing signal that still has this long to live is not pushed again: the client's repeat every 3 s would otherwise flood the socket. */
const REPUSH_BELOW_MS = (TYPING_TTL_SECONDS * 1000) / 2;

const iso = (d: Date): string => d.toISOString();

async function requirePerson(tx: Parameters<typeof myPersonId>[0]): Promise<string> {
  const id = await myPersonId(tx);
  if (!id) throw new HttpError(403, 'forbidden', 'Presence and typing belong to people');
  return id;
}

/**
 * Presence and typing (PLAN A.3): two UNLOGGED tables (migration 0003) that expire by themselves. Presence is read by polling;
 * typing is also pushed over the socket to the channel's audience, as `typing.started`.
 */
export function registerEphemeralRoutes(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...heartbeatRoute,
    schema: { body: HeartbeatRequest, response: HeartbeatResponse },
    // A heartbeat every 30 s per open tab; a few tabs and some retries stay far below this.
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { status = 'online' } = HeartbeatRequest.parse(req.body ?? {});
      await requirePerson(tx);
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

  ctx.http.route({
    ...typingRoute,
    schema: { body: TypingRequest, response: TypingResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = TypingPathParams.parse(req.params);
      const { threadRootId = null } = TypingRequest.parse(req.body ?? {});
      const channel = await requireChannel(tx, channelId);
      await requirePost(tx, channel);
      const me = await requirePerson(tx);
      // Sweep what expired in this channel, then take the signal; `prev` (the row as the statement started) says whether this is a
      // fresh start or a repeat of one that is still showing.
      await tx.query('DELETE FROM app.typing WHERE channel_id = $1 AND expires_at < now()', [channelId]);
      const res = await tx.query<{ expires_at: Date; remaining_ms: number | null }>(
        `WITH prev AS (SELECT expires_at FROM app.typing WHERE channel_id = $1 AND person_id = $2)
         INSERT INTO app.typing AS t (channel_id, person_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
         ON CONFLICT (channel_id, person_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
         RETURNING t.expires_at,
           (SELECT (extract(epoch FROM prev.expires_at - now()) * 1000)::float8 FROM prev) AS remaining_ms`,
        [channelId, me, TYPING_TTL_SECONDS],
      );
      const row = res.rows[0]!;
      if (row.remaining_ms === null || row.remaining_ms < REPUSH_BELOW_MS) {
        const payload = TypingStartedPush.parse({ channelId, personId: me, threadRootId, expiresAt: iso(row.expires_at) });
        for (const person of await audience(tx, channelId)) {
          if (person !== me) await ctx.realtime.pushToPerson(tx, person, WS_TYPING_STARTED, payload);
        }
      }
      return json(TypingResponse.parse({ expiresAt: iso(row.expires_at) }));
    }),
  });

  ctx.http.route({
    ...listTypingRoute,
    schema: { response: ListTypingResponse },
    handler: route(async (req, tx) => {
      const { channelId } = TypingPathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const res = await tx.query<{ person_id: string; expires_at: Date }>(
        `SELECT person_id, expires_at FROM app.typing
          WHERE channel_id = $1 AND expires_at > now() AND person_id IS DISTINCT FROM app.person_id() ORDER BY expires_at`,
        [channelId],
      );
      return json(ListTypingResponse.parse({ typing: res.rows.map((r) => ({ personId: r.person_id, expiresAt: iso(r.expires_at) })) }));
    }),
  });
}
