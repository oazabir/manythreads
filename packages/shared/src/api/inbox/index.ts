import { z } from 'zod';
import { ChannelId, MessageId } from '../../ids.ts';
import {
  INBOX_NAME_MAX,
  INBOX_NOTE_MAX_CHARS,
  InboxItem,
  InboxItemId,
  InboxState,
} from '../../entities/inbox.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// The routes of a team's memory inbox (PLAN P8-14, P8-15, P8-17). Everyone who can read the team drops and sees their own drops and the team's; a team
// lead or a workspace admin also sees what is held and releases, discards and retries. A guest drops nothing. docs/plugins/memory-inbox.md.

export const InboxTeamParams = z.object({ slug: TeamSlug });
export type InboxTeamParams = z.infer<typeof InboxTeamParams>;
export const InboxItemParams = z.object({ slug: TeamSlug, itemId: InboxItemId });
export type InboxItemParams = z.infer<typeof InboxItemParams>;

export const ListInboxItemsQuery = z.object({
  state: InboxState.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListInboxItemsQuery = z.infer<typeof ListInboxItemsQuery>;
export const ListInboxItemsResponse = z.object({
  items: z.array(InboxItem),
  /** Whether the signed-in person may release, discard and retry other people's items (a team lead or a workspace admin). */
  canManage: z.boolean(),
  /** The size cap of one drop for this team, in bytes. */
  maxBytes: z.number().int().min(1),
});
export type ListInboxItemsResponse = z.infer<typeof ListInboxItemsResponse>;
export const listInboxItemsRoute = { method: 'GET', path: '/api/teams/:slug/inbox/items' } as const satisfies ApiRoute;

export const GetInboxItemResponse = z.object({ item: InboxItem, canManage: z.boolean() });
export type GetInboxItemResponse = z.infer<typeof GetInboxItemResponse>;
export const getInboxItemRoute = { method: 'GET', path: '/api/teams/:slug/inbox/items/:itemId' } as const satisfies ApiRoute;

/** The upload's file name travels in `?name=` (or `x-file-name`); the body is the file itself. `teamOnly=true` keeps what is filed out of share digests. */
export const UploadInboxItemQuery = z.object({
  name: z.string().trim().min(1).max(INBOX_NAME_MAX).optional(),
  teamOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type UploadInboxItemQuery = z.infer<typeof UploadInboxItemQuery>;
export const InboxItemResponse = z.object({
  item: InboxItem,
  /** True when the same bytes were already dropped, so no new work was queued (`item` is then the earlier drop's duplicate record). */
  duplicate: z.boolean(),
});
export type InboxItemResponse = z.infer<typeof InboxItemResponse>;
export const uploadInboxItemRoute = { method: 'POST', path: '/api/teams/:slug/inbox/items' } as const satisfies ApiRoute;

/** New note: pasted text with an optional title. A text that is only a web address is filed as a link (the page is not fetched). */
export const CreateInboxNoteRequest = z.strictObject({
  title: z.string().trim().min(1).max(INBOX_NAME_MAX).optional(),
  text: z.string().trim().min(1).max(INBOX_NOTE_MAX_CHARS),
  teamOnly: z.boolean().default(false),
});
export type CreateInboxNoteRequest = z.infer<typeof CreateInboxNoteRequest>;
export const createInboxNoteRoute = { method: 'POST', path: '/api/teams/:slug/inbox/notes' } as const satisfies ApiRoute;

/** The Send to memory action on a message. A private channel needs `confirmPrivate`: the person has been told everyone in the team will see it. */
export const SendToMemoryParams = z.object({ channelId: ChannelId, messageId: MessageId });
export type SendToMemoryParams = z.infer<typeof SendToMemoryParams>;
export const SendToMemoryRequest = z.strictObject({
  confirmPrivate: z.boolean().default(false),
  teamOnly: z.boolean().default(false),
  /** Send the whole thread this message starts or belongs to instead of the one message. */
  thread: z.boolean().default(false),
});
export type SendToMemoryRequest = z.infer<typeof SendToMemoryRequest>;
export const sendToMemoryRoute = { method: 'POST', path: '/api/channels/:channelId/messages/:messageId/send-to-memory' } as const satisfies ApiRoute;

/** Release a held item into the pipeline (a lead or admin), discard it, or put a failed one back in the queue. */
export const InboxItemActionResponse = z.object({ item: InboxItem });
export type InboxItemActionResponse = z.infer<typeof InboxItemActionResponse>;
export const releaseInboxItemRoute = { method: 'POST', path: '/api/teams/:slug/inbox/items/:itemId/release' } as const satisfies ApiRoute;
export const discardInboxItemRoute = { method: 'POST', path: '/api/teams/:slug/inbox/items/:itemId/discard' } as const satisfies ApiRoute;
export const retryInboxItemRoute = { method: 'POST', path: '/api/teams/:slug/inbox/items/:itemId/retry' } as const satisfies ApiRoute;

/** Tells the dropper's open tabs that one of their items moved (queued, held, filed, failed): the client reads the item again. Sent to the dropper only. */
export const WS_INBOX_ITEM_CHANGED = 'inbox.item.changed';
export const InboxItemChangedPush = z.object({ teamId: z.uuid(), itemId: InboxItemId, state: InboxState });
export type InboxItemChangedPush = z.infer<typeof InboxItemChangedPush>;
