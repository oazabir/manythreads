import { z } from 'zod';
import { ChannelId, TeamId, WorkspaceId } from '../ids.ts';

/** A channel was archived (`archived: true`: read-only) or restored (`archived: false`). */
export const ChannelChannelArchivedEvent = z.object({
  type: z.literal('channel.channel.archived'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  archived: z.boolean(),
});
export type ChannelChannelArchivedEvent = z.infer<typeof ChannelChannelArchivedEvent>;
