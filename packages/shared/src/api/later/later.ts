import { z } from 'zod';
import { ChannelKind } from '../../entities/channel.ts';
import { LATER_SNIPPET_MAX } from '../../entities/later.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, ChannelId, LaterItemId, MessageId, TeamId } from '../../ids.ts';

// Later and reminders (PLAN P14-04, plugin `reminders`): a person saves a message to come back to, optionally with a time at which they are
// reminded. Every route acts on the caller's own items; a bot has none (403). The message text shown here is read under the caller's own
// access every time: once they lose it, or the message is deleted, the item stays and says it is no longer available, with no text.

export const LaterState = z.enum(['open', 'done']);
export type LaterState = z.infer<typeof LaterState>;

/** Where the saved message lives: enough to write `#dev` or "Direct message" and to open it. */
export const LaterChannelRef = z.object({
  id: ChannelId,
  name: z.string(),
  kind: ChannelKind,
  teamId: TeamId.nullable(),
});
export type LaterChannelRef = z.infer<typeof LaterChannelRef>;

/** What the caller may read of the saved message right now. */
export const LaterMessage = z.object({
  channel: LaterChannelRef,
  /** The first message of the thread when the saved message is a reply; null otherwise. */
  threadRootId: MessageId.nullable(),
  authorId: ActorId,
  authorName: z.string(),
  /** One line of the text, at most 200 characters. */
  snippet: z.string().max(LATER_SNIPPET_MAX),
  messageCreatedAt: IsoDateTime,
});
export type LaterMessage = z.infer<typeof LaterMessage>;

/**
 * One saved item. `message` is null when the caller can no longer read the message (it was deleted, or their access to its channel ended):
 * the list then says "no longer available" and carries none of its text, author or channel.
 */
export const LaterItem = z.object({
  id: LaterItemId,
  messageId: MessageId,
  state: LaterState,
  /** When the reminder fires; null for a plain "mark for later". */
  remindAt: IsoDateTime.nullable(),
  /** The reminder time has come and the item is still open: the list shows these first. */
  due: z.boolean(),
  createdAt: IsoDateTime,
  doneAt: IsoDateTime.nullable(),
  message: LaterMessage.nullable(),
});
export type LaterItem = z.infer<typeof LaterItem>;

export const LaterItemPathParams = z.object({ itemId: LaterItemId });
export const LaterMessagePathParams = z.object({ messageId: MessageId });

export const ListLaterQuery = z.object({ state: LaterState.default('open') });
export type ListLaterQuery = z.infer<typeof ListLaterQuery>;

/** The caller's items, due ones first, then the nearest reminders, then the rest newest first. `openCount` and `dueCount` cover all open items. */
export const ListLaterResponse = z.object({
  items: z.array(LaterItem),
  openCount: z.number().int().nonnegative(),
  dueCount: z.number().int().nonnegative(),
});
export type ListLaterResponse = z.infer<typeof ListLaterResponse>;
export const listLaterRoute = { method: 'GET', path: '/api/later' } as const;

/**
 * Save a message for later, with a reminder time (`remindAt`) or without (`null`, or left out: a plain mark). Saving a message that is already
 * saved changes its reminder (and reopens it if it was done). The time must be within the next year and not in the past.
 */
export const SaveLaterRequest = z.strictObject({ remindAt: IsoDateTime.nullable().optional() });
export type SaveLaterRequest = z.infer<typeof SaveLaterRequest>;
export const saveLaterRoute = { method: 'PUT', path: '/api/later/messages/:messageId' } as const;

/** Mark an item done or open again. */
export const UpdateLaterRequest = z.strictObject({ state: LaterState });
export type UpdateLaterRequest = z.infer<typeof UpdateLaterRequest>;
export const updateLaterRoute = { method: 'PATCH', path: '/api/later/items/:itemId' } as const;

export const RemoveLaterResponse = z.object({ removed: z.boolean() });
export type RemoveLaterResponse = z.infer<typeof RemoveLaterResponse>;
export const removeLaterRoute = { method: 'DELETE', path: '/api/later/items/:itemId' } as const;
