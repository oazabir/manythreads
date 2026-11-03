import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotId, ChannelId, RunId, SurfaceId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A bot drew a new surface (`surface.render`, P9-04). Ids and counts: never the title or the text of the screen. `teamId` is null for a screen drawn in a private
 * channel, a direct message or a conversation with a bot, so only an admin's policy reaches the line.
 */
export const SurfacesSurfaceRenderedEvent = z.object({
  type: z.literal('surfaces.surface.rendered'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  surfaceId: SurfaceId,
  botId: BotId,
  runId: RunId,
  /** Always 1 for a new surface. */
  version: z.number().int().min(1),
  /** How many parts the checker refused (they are drawn as cards). */
  problemCount: z.number().int().nonnegative(),
  at: IsoDateTime,
});
export type SurfacesSurfaceRenderedEvent = z.infer<typeof SurfacesSurfaceRenderedEvent>;
