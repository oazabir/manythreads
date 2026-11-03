import { HttpError, conflict, forbidden, json, notFound, route, type McpToolsProvider, type PluginContext } from '@manythreads/sdk';
import {
  PostSurfaceDataRequest,
  SURFACE_REGISTRY,
  SurfaceDataPathParams,
  SurfaceDataResponse,
  abuseLimit,
  applyBinding,
  findSurfacePart,
  parseSurface,
  postSurfaceDataRoute,
} from '@manythreads/shared';
import { SURFACE_COLUMNS, type SurfaceRow } from './mappers.ts';

// A part of a screen reads its bound data (PLAN P9-06, docs/plugins/surfaces.md). The page names the screen, its version and the part; everything else (which tool, what
// arguments, which fields to take) is read from the screen's own text, here. The tool is then run AS THE PERSON ASKING, through the gateway's `mcp.tools` provider
// (`readForViewer`): a person's read-only transaction, so it shows what that person may read and never what the bot could. Nothing the bot is granted is asked or used.
//
// What a request can never do: name a tool, give arguments or pick fields. The strict body has only `version`. What the route needs from the person: read the channel.

/** Calls of this route one server runs for one person at the same moment. A page with many live parts asks in turn, so this is rarely met by a person. */
export const DATA_IN_FLIGHT_PER_PERSON = 4;
const inFlight = new Map<string, number>();

/** Forget the counts (tests). */
export function resetDataCalls(): void {
  inFlight.clear();
}

const now = (ctx: PluginContext): string => ctx.runtime.now().toISOString();

export function registerDataRoute(ctx: PluginContext): void {
  ctx.http.route({
    ...postSurfaceDataRoute,
    schema: { body: PostSurfaceDataRequest, response: SurfaceDataResponse },
    rateLimit: abuseLimit('POST', postSurfaceDataRoute.path),
    handler: route(async (req, tx) => {
      const { channelId, surfaceId, nodeId } = SurfaceDataPathParams.parse(req.params);
      const body = PostSurfaceDataRequest.parse(req.body ?? {});
      if (tx.actor.kind !== 'person') throw forbidden('Only a person reads the data of a screen');
      const can = (await tx.query<{ ok: boolean | null }>("SELECT app.channel_can($1::uuid, 'read') AS ok", [channelId])).rows[0]?.ok === true;
      if (!can) throw forbidden('You cannot read this channel');
      const surface = (await tx.query<SurfaceRow>(`SELECT ${SURFACE_COLUMNS} FROM app.surfaces s WHERE s.id = $1::uuid AND s.channel_id = $2::uuid`, [surfaceId, channelId])).rows[0];
      if (!surface) throw notFound('No such screen in this channel');
      if (body.version !== surface.version) {
        throw conflict(`This screen changed since you opened it (it is now version ${surface.version}). Look at the new one first.`);
      }
      const part = findSurfacePart(parseSurface(surface.source, SURFACE_REGISTRY).root, nodeId);
      const def = part === null ? undefined : SURFACE_REGISTRY.get(part.name);
      if (part === null || def === undefined || part.bind === undefined) throw notFound('This screen has no part named that with data to read');
      const fetchedAt = now(ctx);

      const provider = ctx.providers.get<McpToolsProvider>('mcp.tools');
      if (provider === undefined) {
        return json(SurfaceDataResponse.parse({ state: 'error', code: 'unavailable', message: 'Data cannot be read in this deployment.', fetchedAt }));
      }
      const who = tx.actor.id;
      const running = inFlight.get(who) ?? 0;
      if (running >= DATA_IN_FLIGHT_PER_PERSON) throw new HttpError(429, 'rate_limited', 'Too many parts are reading data at once. Wait a moment.');
      inFlight.set(who, running + 1);
      let read;
      try {
        read = await provider.readForViewer(tx, part.bind.tool, { ...part.bind.args });
      } finally {
        const left = (inFlight.get(who) ?? 1) - 1;
        if (left <= 0) inFlight.delete(who);
        else inFlight.set(who, left);
      }
      if (!read.ok) {
        const code = read.code === 'forbidden' || read.code === 'timeout' || read.code === 'too_large' ? read.code : 'unavailable';
        return json(SurfaceDataResponse.parse({ state: 'error', code, message: read.message.slice(0, 400), fetchedAt }));
      }
      const outcome = applyBinding(def, part.props, part.bind, read.data);
      if (outcome.state === 'ok') return json(SurfaceDataResponse.parse({ state: 'ok', props: outcome.props, fetchedAt }));
      if (outcome.state === 'empty') return json(SurfaceDataResponse.parse({ state: 'empty', fetchedAt }));
      return json(SurfaceDataResponse.parse({ state: 'error', code: outcome.code, message: outcome.message, fetchedAt }));
    }),
  });
}
