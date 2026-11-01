import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, ChannelId, MessageId, PollId } from '../../ids.ts';
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

/**
 * The author's own scheduled messages changed somewhere (another tab, or the job that sends them): the client reads the channel's list again.
 * Sent only to the author. `change` says what happened so the screen can word a notice ("Your scheduled message was not sent").
 */
export const WS_SCHEDULED_CHANGED = 'scheduled.changed';
export const ScheduledChangedPush = z.object({
  channelId: ChannelId,
  change: z.enum(['scheduled', 'edited', 'sent', 'refused', 'cancelled']),
});
export type ScheduledChangedPush = z.infer<typeof ScheduledChangedPush>;

/**
 * The counts of a poll changed (a vote, a withdrawn vote, the poll closed): sent to everyone who can read the channel so the bars move while the
 * card is open. It holds the totals only, never who voted or for what, and nothing that depends on the reader (their own vote stays as it was).
 */
export const WS_POLL_CHANGED = 'poll.changed';
export const PollChangedPush = z.object({
  channelId: ChannelId,
  messageId: MessageId,
  pollId: PollId,
  votes: z.array(z.number().int().nonnegative()),
  voters: z.number().int().nonnegative(),
  /** The poll's change counter (`PollView.version`): a page ignores a push older than the poll it already holds. */
  version: z.number().int().nonnegative(),
  closed: z.boolean(),
  closedAt: IsoDateTime.nullable(),
  resultMessageId: MessageId.nullable(),
});
export type PollChangedPush = z.infer<typeof PollChangedPush>;
