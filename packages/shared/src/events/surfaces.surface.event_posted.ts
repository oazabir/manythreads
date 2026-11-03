import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, SurfaceEventId, SurfaceId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A person answered a surface: pressed a button or sent a form (P9-04). The line says which part and which event, never what was sent: the payload stays in the
 * surface's history, read by whoever reads the channel, and by the bot through `surface.event`.
 */
export const SurfacesSurfaceEventPostedEvent = z.object({
  type: z.literal('surfaces.surface.event_posted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  surfaceId: SurfaceId,
  eventId: SurfaceEventId,
  /** The person's actor. */
  actorId: ActorId,
  /** The part answered (its name on the screen) and the event the part declares. */
  nodeId: z.string().min(1).max(64),
  eventName: z.string().min(1).max(32),
  /** The version of the surface the person was looking at (it was the current one). */
  version: z.number().int().min(1),
  at: IsoDateTime,
});
export type SurfacesSurfaceEventPostedEvent = z.infer<typeof SurfacesSurfaceEventPostedEvent>;
