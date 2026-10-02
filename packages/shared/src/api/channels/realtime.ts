import { z } from 'zod';
import { ActorId, ChannelId, MessageId } from '../../ids.ts';
import { Channel } from '../../entities/channel.ts';
import { Emoji } from '../../entities/message.ts';
import { ChannelMessage } from './common.ts';

// WebSocket pushes of the channels plugin: `{ type, id, payload }` envelopes (transport/envelope.ts), sent only to people who can
// see the channel. A push stays small: `message` rides along when it fits, otherwise the client fetches `messageId`.

export const WS_MESSAGE_POSTED = 'message.posted';
export const WS_MESSAGE_EDITED = 'message.edited';
export const WS_MESSAGE_DELETED = 'message.deleted';
export const WS_REACTION_CHANGED = 'reaction.changed';
export const WS_CHANNEL_CREATED = 'channel.created';

export const MessagePostedPush = z.object({
  channelId: ChannelId,
  messageId: MessageId,
  threadRootId: MessageId.nullable(),
  message: ChannelMessage.optional(),
});
export type MessagePostedPush = z.infer<typeof MessagePostedPush>;

export const MessageEditedPush = MessagePostedPush;
export type MessageEditedPush = z.infer<typeof MessageEditedPush>;

export const MessageDeletedPush = z.object({
  channelId: ChannelId,
  messageId: MessageId,
  threadRootId: MessageId.nullable(),
});
export type MessageDeletedPush = z.infer<typeof MessageDeletedPush>;

export const ReactionChangedPush = z.object({
  channelId: ChannelId,
  messageId: MessageId,
  actorId: ActorId,
  emoji: Emoji,
  added: z.boolean(),
  /** How many actors now use this emoji on the message. */
  count: z.number().int().nonnegative(),
});
export type ReactionChangedPush = z.infer<typeof ReactionChangedPush>;

export const ChannelCreatedPush = z.object({ channel: Channel });
export type ChannelCreatedPush = z.infer<typeof ChannelCreatedPush>;
