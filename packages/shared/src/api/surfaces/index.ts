import { z } from 'zod';
import { SURFACE_NODE_ID_MAX, Surface, SurfaceEvent } from '../../entities/surface.ts';
import { ChannelId, MessageId, SurfaceId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Screens bots draw (PLAN P9-04, plugin `surfaces`, docs/plugins/surfaces.md). A bot draws and changes a surface through its tools (`surface.render`,
// `surface.update`); these routes are what the web app uses: read the surfaces of a channel and send back a click or a form. Whoever can read the channel reads its
// surfaces; whoever can post in it may answer one. There is no route that draws, changes or deletes: only the bot that owns a surface does, inside its own run.

export const SurfacePathParams = z.object({ channelId: ChannelId, surfaceId: SurfaceId });
export type SurfacePathParams = z.infer<typeof SurfacePathParams>;
export const ChannelSurfacesPathParams = z.object({ channelId: ChannelId });
export type ChannelSurfacesPathParams = z.infer<typeof ChannelSurfacesPathParams>;

/** The surfaces of a channel, newest first. With `threadRootId`, only those drawn in that thread. */
export const ListSurfacesQuery = z.object({
  threadRootId: MessageId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListSurfacesQuery = z.infer<typeof ListSurfacesQuery>;
export const ListSurfacesResponse = z.object({ items: z.array(Surface) });
export type ListSurfacesResponse = z.infer<typeof ListSurfacesResponse>;
export const listSurfacesRoute = { method: 'GET', path: '/api/channels/:channelId/surfaces' } as const satisfies ApiRoute;

export const GetSurfaceResponse = Surface;
export type GetSurfaceResponse = z.infer<typeof GetSurfaceResponse>;
export const getSurfaceRoute = { method: 'GET', path: '/api/channels/:channelId/surfaces/:surfaceId' } as const satisfies ApiRoute;

/**
 * A click or a form sent back to the bot. `version` is the version of the surface the person was looking at: an answer to a screen that has changed since is
 * refused (409) so the page can show the new one first. `nodeId` and `name` must be a part drawn on the surface and an event that part declares; `payload` must
 * fit that event's shape exactly. There is no field for a tool, a channel or a person: an event is data for the bot, never a command to the platform.
 */
export const PostSurfaceEventRequest = z.strictObject({
  nodeId: z.string().min(1).max(SURFACE_NODE_ID_MAX),
  name: z.string().min(1).max(32),
  version: z.number().int().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type PostSurfaceEventRequest = z.infer<typeof PostSurfaceEventRequest>;
export const PostSurfaceEventResponse = z.object({ event: SurfaceEvent });
export type PostSurfaceEventResponse = z.infer<typeof PostSurfaceEventResponse>;
export const postSurfaceEventRoute = { method: 'POST', path: '/api/channels/:channelId/surfaces/:surfaceId/events' } as const satisfies ApiRoute;

/** The live push that says a surface was drawn, changed or answered: the page that shows it reads it again. */
export const WS_SURFACE_CHANGED = 'surfaces.changed';
export const SurfaceChangedPush = z.object({ channelId: ChannelId, surfaceId: SurfaceId, version: z.number().int().min(1) });
export type SurfaceChangedPush = z.infer<typeof SurfaceChangedPush>;
