import { z } from 'zod';
import { ActorId, ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';

/** A message was deleted (soft: the row stays, its text is no longer served or searched) by its author or a team lead. */
export const ChannelMessageDeletedEvent = z.object({
  type: z.literal('channel.message.deleted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  messageId: MessageId,
  deletedBy: ActorId,
  threadRootId: MessageId.nullable(),
});
export type ChannelMessageDeletedEvent = z.infer<typeof ChannelMessageDeletedEvent>;
