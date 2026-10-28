import { HttpError } from '@manythreads/sdk';
import {
  ListTypingResponse,
  TYPING_TTL_SECONDS,
  TypingPathParams,
  TypingRequest,
  TypingResponse,
  TypingStartedPush,
  WS_TYPING_STARTED,
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
  if (!id) throw new HttpError(403, 'forbidden', 'Typing belongs to people');
  return id;
}

/**
 * Typing (PLAN A.3): an UNLOGGED table (migration 0003) that expires by itself, also pushed over the socket to the channel's audience as
 * `typing.started`. The heartbeat table `presence` is created by the same migration, but its routes moved to the presence plugin (P14-01).
 */
export function registerEphemeralRoutes(deps: Deps): void {
  const { ctx } = deps;

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
        const others = (await audience(tx, channelId)).filter((person) => person !== me);
        await ctx.realtime.pushToPeople(tx, others, WS_TYPING_STARTED, payload);
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
