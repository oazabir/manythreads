import { z } from 'zod';
import { ActorId, ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';

/** The author changed the text of a message. */
export const ChannelMessageEditedEvent = z.object({
  type: z.literal('channel.message.edited'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  messageId: MessageId,
  editorId: ActorId,
  threadRootId: MessageId.nullable(),
});
export type ChannelMessageEditedEvent = z.infer<typeof ChannelMessageEditedEvent>;
