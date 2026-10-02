import { z } from 'zod';
import { Emoji } from '../entities/message.ts';
import { ActorId, ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';

/** An actor added (`added: true`) or took back (`added: false`) a reaction. Only a real change is an event. */
export const ChannelReactionChangedEvent = z.object({
  type: z.literal('channel.reaction.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  messageId: MessageId,
  actorId: ActorId,
  emoji: Emoji,
  added: z.boolean(),
});
export type ChannelReactionChangedEvent = z.infer<typeof ChannelReactionChangedEvent>;
