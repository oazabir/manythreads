import { z } from 'zod';
import { Message, Emoji } from '../../entities/message.ts';
import { Page } from '../../common/page.ts';
import { ChannelId, MessageId } from '../../ids.ts';
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
