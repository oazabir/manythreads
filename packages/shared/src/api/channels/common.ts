import { z } from 'zod';
import { Message, Emoji } from '../../entities/message.ts';
import { IsoDateTime } from '../../common/time.ts';
import { FileSummary } from '../../entities/file.ts';
import { ActorKind } from '../../entities/kernel.ts';
import { ChannelKind } from '../../entities/channel.ts';
import { PollView } from '../../entities/poll.ts';
import { ActorId, ChannelId, MessageId, TeamId } from '../../ids.ts';

/** A channel name as a client may write it: with or without the leading `#` (the server stores it without). */
export const ChannelNameInput = z.string().regex(/^#?[a-z0-9][a-z0-9-]{0,62}$/, 'channel name like "dev" or "#dev"');
export type ChannelNameInput = z.infer<typeof ChannelNameInput>;

export const ChannelPurpose = z.string().trim().max(250);

/** What a reaction looks like to the caller: how many actors used the emoji, and whether the caller is one of them. */
export const ReactionSummary = z.object({ emoji: Emoji, count: z.number().int().positive(), mine: z.boolean() });
export type ReactionSummary = z.infer<typeof ReactionSummary>;

/** Who wrote a message, resolved by the server for the messages the caller can read (a guest has no roster to look the name up in). */
export const MessageAuthor = z.object({
  actorId: ActorId,
  displayName: z.string(),
  kind: ActorKind,
  /**
   * For an author of kind `system`: which sender it is, said by the server (never guessed from the name, which a webhook's admin chooses): the workspace's
   * `reminders` sender, or an incoming `webhook`. Absent for a person, a bot, or a system author that is neither.
   */
  sender: z.enum(['reminders', 'webhook']).optional(),
});
export type MessageAuthor = z.infer<typeof MessageAuthor>;

/** The longest excerpt of a forwarded message a card carries. */
export const FORWARD_EXCERPT_CHARS = 280;

/**
 * The card a forwarded message shows (P14-12). The forwarded message stores only a reference to the original, never a copy of its text; the
 * server resolves the reference for **each reader**: someone who may read the original sees who wrote it, when, an excerpt and where it lives,
 * anyone else sees only that a message was forwarded (`hidden`), and the original having been deleted is `deleted`.
 */
export const ForwardedMessage = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('visible'),
    channelId: ChannelId,
    channelKind: ChannelKind,
    /** Null for a direct message or a conversation with a bot (they have no name to show). */
    channelName: z.string().nullable(),
    teamId: TeamId.nullable(),
    messageId: MessageId,
    /** Set when the original is a reply: the link opens its thread. */
    threadRootId: MessageId.nullable(),
    author: MessageAuthor.optional(),
    createdAt: IsoDateTime,
    excerpt: z.string().max(FORWARD_EXCERPT_CHARS + 1),
  }),
  z.object({ state: z.literal('hidden') }),
  z.object({ state: z.literal('deleted') }),
]);
export type ForwardedMessage = z.infer<typeof ForwardedMessage>;

/**
 * A message as the channel view lists it: the stored message plus its reactions and, for a thread root, how many replies it has.
 * A deleted message keeps its row (so a thread keeps its place): `deletedAt` is set, `body` is a fixed tombstone and `bodyPlain` is empty.
 */
export const ChannelMessage = Message.extend({
  reactions: z.array(ReactionSummary),
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime.nullable(),
  /** Top-level feed only (P21-03): up to three people who replied, the newest reply's author first, for the avatars on the reply count. */
  replyAuthors: z.array(MessageAuthor).max(3).optional(),
  /** Top-level feed only (P21-03): the reader has unread replies in this message's thread. */
  unreadReplies: z.boolean().optional(),
  /** `meta.attachments` resolved for the caller (a file they cannot read is left out). Always sent; optional here so older fixtures still parse. */
  attachments: z.array(FileSummary).optional(),
  /** The author's name and kind. Optional so older fixtures still parse; the server always sends it for a message the caller can read. */
  author: MessageAuthor.optional(),
  /** Set on a message that forwards another one: the original as this reader may see it (see `ForwardedMessage`). */
  forward: ForwardedMessage.optional(),
  /** Set on the channel's own copy of a thread reply sent with "Also send to channel": the first message of that thread. */
  alsoSentFromThread: MessageId.optional(),
  /** Set on a poll message (P14-07): the poll as this reader sees it. The message text is the plain-text form of the poll, for search and bots. */
  poll: PollView.optional(),
});
export type ChannelMessage = z.infer<typeof ChannelMessage>;
