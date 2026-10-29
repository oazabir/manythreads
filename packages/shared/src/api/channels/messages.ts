import { z } from 'zod';
import { Message, Emoji } from '../../entities/message.ts';
import { Page } from '../../common/page.ts';
import { ChannelId, MessageId } from '../../ids.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ReadStateEntry } from '../../entities/read-state.ts';
import { ChannelMessage, ReactionSummary } from './common.ts';

// Posting is `postMessageRoute` (api/messages/post-message.ts): POST /api/channels/:channelId/messages.

/**
 * Newest first. `before` is the id of the oldest message the client has (ids are uuid v7, so they sort by time); the page holds
 * the `limit` messages older than it, and `nextCursor` is the `before` for the next page (null when there is nothing older).
 * Without `threadRootId` the list is the channel's own messages (replies live in their thread); with it, the replies to that root.
 */
export const ListMessagesQuery = z.object({
  before: MessageId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  threadRootId: MessageId.optional(),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;
export const ListMessagesResponse = Page(ChannelMessage);
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;
export const listMessagesRoute = { method: 'GET', path: '/api/channels/:channelId/messages' } as const;

export const MessagePathParams = z.object({ channelId: ChannelId, messageId: MessageId });
export type MessagePathParams = z.infer<typeof MessagePathParams>;

export const GetMessageResponse = ChannelMessage;
export type GetMessageResponse = z.infer<typeof GetMessageResponse>;
export const getMessageRoute = { method: 'GET', path: '/api/channels/:channelId/messages/:messageId' } as const;

/** Edit your own message (the author only); `editedAt` is set. A deleted message cannot be edited. */
export const EditMessageRequest = Message.pick({ body: true }).strict();
export type EditMessageRequest = z.infer<typeof EditMessageRequest>;
export const EditMessageResponse = ChannelMessage;
export type EditMessageResponse = z.infer<typeof EditMessageResponse>;
export const editMessageRoute = { method: 'PATCH', path: '/api/channels/:channelId/messages/:messageId' } as const;

/** Delete a message (its author, or a lead of the channel's team). Deleting twice is fine: `deleted` is false the second time. */
export const DeleteMessageResponse = z.object({ deleted: z.boolean() });
export type DeleteMessageResponse = z.infer<typeof DeleteMessageResponse>;
export const deleteMessageRoute = { method: 'DELETE', path: '/api/channels/:channelId/messages/:messageId' } as const;

export const ReactRequest = z.strictObject({ emoji: Emoji });
export type ReactRequest = z.infer<typeof ReactRequest>;
export const ReactResponse = z.object({ added: z.boolean(), reactions: z.array(ReactionSummary) });
export type ReactResponse = z.infer<typeof ReactResponse>;
export const reactRoute = { method: 'POST', path: '/api/channels/:channelId/messages/:messageId/reactions' } as const;

export const UnreactPathParams = z.object({ channelId: ChannelId, messageId: MessageId, emoji: Emoji });
export const UnreactResponse = z.object({ removed: z.boolean(), reactions: z.array(ReactionSummary) });
export type UnreactResponse = z.infer<typeof UnreactResponse>;
export const unreactRoute = { method: 'DELETE', path: '/api/channels/:channelId/messages/:messageId/reactions/:emoji' } as const;

/**
 * Earlier versions of a message (P14-12), oldest first, the current text not included. Whoever may read the message may read them; the
 * author may clear them; deleting the message drops them. `writtenAt` is when that text was written, `replacedAt` when an edit replaced it.
 */
export const MessageVersion = z.object({
  id: z.uuid(),
  body: z.string(),
  writtenAt: IsoDateTime,
  replacedAt: IsoDateTime,
});
export type MessageVersion = z.infer<typeof MessageVersion>;
export const ListMessageVersionsResponse = z.object({ items: z.array(MessageVersion) });
export type ListMessageVersionsResponse = z.infer<typeof ListMessageVersionsResponse>;
export const listMessageVersionsRoute = { method: 'GET', path: '/api/channels/:channelId/messages/:messageId/versions' } as const;

/** The author takes their earlier versions away (a token pasted by mistake and then edited out stays in the history otherwise). */
export const ClearMessageVersionsResponse = z.object({ cleared: z.number().int().nonnegative() });
export type ClearMessageVersionsResponse = z.infer<typeof ClearMessageVersionsResponse>;
export const clearMessageVersionsRoute = { method: 'DELETE', path: '/api/channels/:channelId/messages/:messageId/versions' } as const;

/** Longest note a forwarder may add above the quote card. */
export const FORWARD_NOTE_MAX = 4_000;

/**
 * Forward a message you can read into another channel or direct message you can post in. The new message is the forwarder's own (their name,
 * their optional note); it carries a reference to the original, not a copy of its text, so people who cannot read the original see no more
 * than that a message was forwarded.
 */
export const ForwardMessageRequest = z.strictObject({
  targetChannelId: ChannelId,
  note: z.string().trim().max(FORWARD_NOTE_MAX).optional(),
});
export type ForwardMessageRequest = z.infer<typeof ForwardMessageRequest>;
export const ForwardMessageResponse = ChannelMessage;
export type ForwardMessageResponse = z.infer<typeof ForwardMessageResponse>;
export const forwardMessageRoute = { method: 'POST', path: '/api/channels/:channelId/messages/:messageId/forward' } as const;

/**
 * "Mark unread from here": the caller's read position goes back to just before this message, so it and everything after it count as unread
 * again (in the channel for a channel message, in the thread for a reply). Nothing is sent to anybody else. Answers the new read state.
 */
export const MarkMessageUnreadResponse = ReadStateEntry;
export type MarkMessageUnreadResponse = z.infer<typeof MarkMessageUnreadResponse>;
export const markMessageUnreadRoute = { method: 'POST', path: '/api/channels/:channelId/messages/:messageId/unread' } as const;
