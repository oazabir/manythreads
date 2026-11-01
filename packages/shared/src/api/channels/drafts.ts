import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { Message, NO_NUL_MESSAGE, hasNul } from '../../entities/message.ts';
import { ChannelId, MessageId } from '../../ids.ts';

// Drafts kept on the server (PLAN P14-02, plugin `channels`; docs/plugins/channels.md). The text a person has typed but not sent, one per channel and one
// per thread, so it is there again on another device. A draft is private to its owner (nobody else reads it, an admin included), never announced (no
// event, no push) and gone when the person sends a message to that channel or thread.

/** The most drafts one person keeps at once; saving one more drops the one that was changed longest ago. */
export const DRAFTS_MAX_PER_PERSON = 200;

/** The longest draft, the same as the longest message. */
export const DRAFT_MAX_CHARS = 40_000;

/** One draft: the channel's own box (`threadRootId` null) or the reply box of one thread. */
export const MessageDraft = z.object({
  channelId: ChannelId,
  threadRootId: MessageId.nullable(),
  body: Message.shape.body,
  updatedAt: IsoDateTime,
});
export type MessageDraft = z.infer<typeof MessageDraft>;

export const DraftChannelPathParams = z.object({ channelId: ChannelId });

/** The caller's drafts in one channel (its own box and its threads'), most recently changed first. */
export const ListDraftsResponse = z.object({ items: z.array(MessageDraft) });
export type ListDraftsResponse = z.infer<typeof ListDraftsResponse>;
export const listDraftsRoute = { method: 'GET', path: '/api/channels/:channelId/drafts' } as const;

/**
 * Save the draft of the channel's box (no `threadRootId`) or of a thread's reply box. A text that is empty after trimming deletes the draft instead
 * (`draft` is then null). Needs the right to post in the channel.
 */
export const SaveDraftRequest = z.strictObject({
  threadRootId: MessageId.nullish(),
  /** At most as long as a message; may be empty (that clears the draft). */
  body: z.string().max(DRAFT_MAX_CHARS).refine((v) => !hasNul(v), { message: NO_NUL_MESSAGE }),
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;
export const SaveDraftResponse = z.object({ draft: MessageDraft.nullable() });
export type SaveDraftResponse = z.infer<typeof SaveDraftResponse>;
export const saveDraftRoute = { method: 'PUT', path: '/api/channels/:channelId/draft' } as const;

/** Delete one draft. Deleting what is not there is fine: `deleted` is false. */
export const DeleteDraftQuery = z.object({ threadRootId: MessageId.optional() });
export type DeleteDraftQuery = z.infer<typeof DeleteDraftQuery>;
export const DeleteDraftResponse = z.object({ deleted: z.boolean() });
export type DeleteDraftResponse = z.infer<typeof DeleteDraftResponse>;
export const deleteDraftRoute = { method: 'DELETE', path: '/api/channels/:channelId/draft' } as const;
