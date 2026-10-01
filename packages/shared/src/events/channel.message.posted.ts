import { z } from 'zod';
import { ActorId, ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';

export const ChannelMessagePostedEvent = z.object({
  type: z.literal('channel.message.posted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  messageId: MessageId,
  authorId: ActorId,
  threadRootId: MessageId.nullable(),
});
export type ChannelMessagePostedEvent = z.infer<typeof ChannelMessagePostedEvent>;
