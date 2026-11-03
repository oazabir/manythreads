import { HttpError, conflict, forbidden, invalid, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  ChannelSurfacesPathParams,
  GetSurfaceResponse,
  ListSurfacesQuery,
  ListSurfacesResponse,
  PostSurfaceEventRequest,
  PostSurfaceEventResponse,
  SURFACE_PENDING_EVENTS_MAX,
  SURFACE_PENDING_PER_PERSON_MAX,
  SURFACE_REGISTRY,
  SurfacePathParams,
  SurfacesSurfaceEventPostedEvent,
  abuseLimit,
  checkSurfaceEvent,
  getSurfaceRoute,
  listSurfacesRoute,
  postSurfaceEventRoute,
} from '@manythreads/shared';
import { SURFACE_COLUMNS, SURFACE_EVENT_COLUMNS, toSurface, toSurfaceEvent, type SurfaceEventRow, type SurfaceRow } from './mappers.ts';
import { registerDataRoute } from './data.ts';
import { eventTeamId, pushChanged } from './notify.ts';

// The routes the web app uses (PLAN P9-04, docs/plugins/surfaces.md). Reading is judged by the row-level security of the tables, through the channel: hide the
// channel and the next read is a 403 or a 404. There is no route that draws, changes or deletes a surface; those are the bot's tools, inside its own run.
//
// What a person's answer can never be: a command. The request has no field for a tool, a channel, a person or a version of the surface to write; the part and
// the event are looked up on the surface as it is now and the payload is judged by the shape that part declares (checkSurfaceEvent). All the route does with a
// good answer is write one history line the bot reads later.

async function requireReadable(tx: PluginTx, channelId: string): Promise<void> {
  const ok = (await tx.query<{ ok: boolean | null }>("SELECT app.channel_can($1::uuid, 'read') AS ok", [channelId])).rows[0]?.ok === true;
  if (!ok) throw forbidden('You cannot read this channel');
}

export function registerRoutes(ctx: PluginContext): void {
  registerDataRoute(ctx);
  ctx.http.route({
    ...listSurfacesRoute,
    schema: { query: ListSurfacesQuery, response: ListSurfacesResponse },
    rateLimit: { limit: 600, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = ChannelSurfacesPathParams.parse(req.params);
      const query = ListSurfacesQuery.parse(req.query);
      await requireReadable(tx, channelId);
      const rows = (
        await tx.query<SurfaceRow>(
          `SELECT ${SURFACE_COLUMNS} FROM app.surfaces s
            WHERE s.channel_id = $1::uuid AND ($2::uuid IS NULL OR s.thread_root_id = $2::uuid)
            ORDER BY s.created_at DESC, s.id DESC LIMIT $3`,
          [channelId, query.threadRootId ?? null, query.limit],
        )
      ).rows;
      return json(ListSurfacesResponse.parse({ items: rows.map(toSurface) }));
    }),
  });

  ctx.http.route({
    ...getSurfaceRoute,
    schema: { response: GetSurfaceResponse },
    rateLimit: { limit: 600, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, surfaceId } = SurfacePathParams.parse(req.params);
      await requireReadable(tx, channelId);
      const row = (await tx.query<SurfaceRow>(`SELECT ${SURFACE_COLUMNS} FROM app.surfaces s WHERE s.id = $1::uuid AND s.channel_id = $2::uuid`, [surfaceId, channelId])).rows[0];
      if (!row) throw notFound('No such screen in this channel');
      return json(GetSurfaceResponse.parse(toSurface(row)));
    }),
  });

  // A person answers a screen: one history line, nothing else happens. Judged, in this order: a person (a bot never answers its own screen), may post in the
  // channel, the screen is in this channel, it is the version the person saw, the part and event exist on it, the payload fits, the bot is not drowning in them.
  ctx.http.route({
    ...postSurfaceEventRoute,
    schema: { body: PostSurfaceEventRequest, response: PostSurfaceEventResponse },
    rateLimit: abuseLimit('POST', postSurfaceEventRoute.path),
    handler: route(async (req, tx) => {
      const { channelId, surfaceId } = SurfacePathParams.parse(req.params);
      const body = PostSurfaceEventRequest.parse(req.body ?? {});
      const who = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id()::text AS person, app.actor()::text AS actor')).rows[0];
      if (!who?.person || !who.actor) throw forbidden('Only a person answers a screen');
      const can = (await tx.query<{ ok: boolean | null }>("SELECT app.lookup_channel_can($1::uuid, 'post') AS ok", [channelId])).rows[0]?.ok === true;
      if (!can) throw forbidden('You cannot post in this channel, so you cannot answer a screen in it');
      // FOR SHARE: the screen is read as it is at this moment and held until this click is written. A concurrent `surface.update` (FOR UPDATE) waits for the click
      // to commit, so its history line always comes after it; a click that waited for an update re-reads the new version and is refused as stale. Without the lock a
      // click could be written against a version that has just gone, and the bot's "answered since the last update" cut (by id order) could hide it.
      const surface = (
        await tx.query<SurfaceRow>(`SELECT ${SURFACE_COLUMNS} FROM app.surfaces s WHERE s.id = $1::uuid AND s.channel_id = $2::uuid FOR SHARE OF s`, [surfaceId, channelId])
      ).rows[0];
      if (!surface) throw notFound('No such screen in this channel');
      if (body.version !== surface.version) {
        throw conflict(`This screen changed since you opened it (it is now version ${surface.version}). Look at the new one first.`);
      }
      const checked = checkSurfaceEvent(SURFACE_REGISTRY, surface.source, { nodeId: body.nodeId, name: body.name, payload: body.payload });
      if (!checked.ok) throw invalid(checked.message);
      const waiting = (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.surface_events e
            WHERE e.surface_id = $1::uuid AND e.kind = 'event'
              AND e.id > coalesce((SELECT b.id FROM app.surface_events b WHERE b.surface_id = $1::uuid AND b.kind IN ('render', 'update') ORDER BY b.id DESC LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid)`,
          [surface.id],
        )
      ).rows[0]!.n;
      const mine = (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.surface_events e
            WHERE e.surface_id = $1::uuid AND e.kind = 'event' AND e.actor_id = app.actor()
              AND e.id > coalesce((SELECT b.id FROM app.surface_events b WHERE b.surface_id = $1::uuid AND b.kind IN ('render', 'update') ORDER BY b.id DESC LIMIT 1), '00000000-0000-0000-0000-000000000000'::uuid)`,
          [surface.id],
        )
      ).rows[0]!.n;
      if (mine >= SURFACE_PENDING_PER_PERSON_MAX) {
        throw new HttpError(429, 'rate_limited', 'You have already sent the bot several answers on this screen. Wait until it has answered.');
      }
      if (waiting >= SURFACE_PENDING_EVENTS_MAX) {
        throw new HttpError(429, 'rate_limited', 'Too many answers are waiting for the bot. Wait until it has answered.');
      }
      const row = (
        await tx.query<SurfaceEventRow>(
          `WITH ins AS (
             INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version, node_id, payload)
             VALUES ($1::uuid, $2::uuid, $3::uuid, app.actor(), 'event', $4::int, $5, $6::jsonb) RETURNING *)
           SELECT ${SURFACE_EVENT_COLUMNS} FROM ins e`,
          [surface.id, surface.workspace_id, surface.channel_id, surface.version, body.nodeId, JSON.stringify({ name: body.name, data: checked.payload })],
        )
      ).rows[0]!;
      await ctx.audit.emit(
        tx,
        SurfacesSurfaceEventPostedEvent.parse({
          type: 'surfaces.surface.event_posted',
          schemaVersion: 1,
          workspaceId: surface.workspace_id,
          teamId: await eventTeamId(tx, surface.channel_id),
          channelId: surface.channel_id,
          surfaceId: surface.id,
          eventId: row.id,
          actorId: who.actor,
          nodeId: body.nodeId,
          eventName: body.name,
          version: surface.version,
          at: ctx.runtime.now().toISOString(),
        }),
      );
      await pushChanged(ctx, tx, { channelId: surface.channel_id, surfaceId: surface.id, version: surface.version });
      return json(PostSurfaceEventResponse.parse({ event: toSurfaceEvent(row) }), 201);
    }),
  });
}
