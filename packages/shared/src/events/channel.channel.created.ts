import { z } from 'zod';
import { ChannelKind } from '../entities/channel.ts';
import { ChannelId, TeamId, WorkspaceId } from '../ids.ts';

/** A channel was created, by a team lead, an admin, or from a team template. */
export const ChannelChannelCreatedEvent = z.object({
  type: z.literal('channel.channel.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  name: z.string(),
  kind: ChannelKind,
  private: z.boolean(),
});
export type ChannelChannelCreatedEvent = z.infer<typeof ChannelChannelCreatedEvent>;
