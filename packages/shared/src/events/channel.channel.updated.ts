import { z } from 'zod';
import { ChannelGroupId, ChannelId, TeamId, WorkspaceId } from '../ids.ts';

/** A channel was renamed, got a new purpose or moved to another group. Only the changed fields are present. */
export const ChannelChannelUpdatedEvent = z.object({
  type: z.literal('channel.channel.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  changes: z.object({
    name: z.string().optional(),
    purpose: z.string().optional(),
    groupId: ChannelGroupId.nullable().optional(),
  }),
});
export type ChannelChannelUpdatedEvent = z.infer<typeof ChannelChannelUpdatedEvent>;
