import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotId, ChannelId, RunId, SurfaceId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A bot changed some parts of a surface (`surface.update`, P9-04); `version` is the new version. Ids and counts only. A patch the checker refused is not an
 * update: it is a `rejected` line in the surface's own history.
 */
export const SurfacesSurfaceUpdatedEvent = z.object({
  type: z.literal('surfaces.surface.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  surfaceId: SurfaceId,
  botId: BotId,
  runId: RunId,
  version: z.number().int().min(1),
  /** Parts replaced and parts added by the patch. */
  replacedCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  at: IsoDateTime,
});
export type SurfacesSurfaceUpdatedEvent = z.infer<typeof SurfacesSurfaceUpdatedEvent>;
