import { z } from 'zod';
import { ActorId, ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';

/** A message was pinned to its channel (`pinned: true`) or unpinned (`pinned: false`) by `actorId` (P31-07). Only a real change is an event. */
export const ChannelMessagePinChangedEvent = z.object({
  type: z.literal('channel.message.pin_changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  messageId: MessageId,
  threadRootId: MessageId.nullable(),
  actorId: ActorId,
  pinned: z.boolean(),
});
export type ChannelMessagePinChangedEvent = z.infer<typeof ChannelMessagePinChangedEvent>;
