import { z } from 'zod';
import { InboxItemId } from '../../entities/inbox.ts';
import { TaskId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// Action items on the board (PLAN P8-20). A filed item may have produced an `Action Items` concept (one `- [ ] what (owner: name; due: YYYY-MM-DD)` line per
// action, packages/shared/src/okf/action-items.ts). The Inbox tab shows each action with an "Add to board" button. The click is the PERSON's act: the web
// calls the tasks API (`POST /api/teams/:slug/tasks`) with `prepared` as the signed-in person, never a bot, and then records the card here so the
// action shows as added. docs/plugins/memory-inbox.md.

export const InboxActionsParams = z.object({ slug: TeamSlug, itemId: InboxItemId });
export type InboxActionsParams = z.infer<typeof InboxActionsParams>;

/**
 * The body to send to `POST /api/teams/:slug/tasks` for this action: exactly the fields `CreateTaskRequest` takes. A card that is not code still has a branch
 * field; `main` is filled in so the person only has to confirm. The owner and the due date have no field on a card, so they are written into the description.
 */
export const InboxActionPreparedTask = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000),
  kind: z.literal('other'),
  priority: z.literal('normal'),
  branch: z.literal('main'),
});
export type InboxActionPreparedTask = z.infer<typeof InboxActionPreparedTask>;

export const InboxAction = z.object({
  /** The concept the action is written in, and its place among that concept's actions: together they name the action. */
  conceptPath: z.string(),
  index: z.number().int().min(0),
  what: z.string(),
  /** The owner as the item names them. */
  ownerName: z.string().nullable(),
  /** The owner as a person of this team, when the name matches exactly one of them; the web may hand the card over to them after it is made. */
  ownerActorId: z.uuid().nullable(),
  due: z.string().nullable(),
  done: z.boolean(),
  prepared: InboxActionPreparedTask,
  /** The card this action became, when somebody added it. */
  taskId: TaskId.nullable(),
  addedBy: z.uuid().nullable(),
});
export type InboxAction = z.infer<typeof InboxAction>;

export const ListInboxActionsResponse = z.object({
  /** The actions of the item's `Action Items` concepts, in the order they are written. Empty for an item that has none (or is not filed). */
  actions: z.array(InboxAction),
  /** Whether the signed-in person may add cards to this team's board. */
  canAdd: z.boolean(),
});
export type ListInboxActionsResponse = z.infer<typeof ListInboxActionsResponse>;
export const listInboxActionsRoute = { method: 'GET', path: '/api/teams/:slug/inbox/items/:itemId/actions' } as const satisfies ApiRoute;

/** After the web made the card as the person, it tells the inbox which action it was. The inbox checks the card exists and that this person made it. */
export const RecordInboxActionRequest = z.strictObject({
  conceptPath: z.string().min(1).max(500),
  index: z.number().int().min(0).max(1000),
  taskId: TaskId,
});
export type RecordInboxActionRequest = z.infer<typeof RecordInboxActionRequest>;
export const RecordInboxActionResponse = z.object({ action: InboxAction });
export type RecordInboxActionResponse = z.infer<typeof RecordInboxActionResponse>;
export const recordInboxActionRoute = { method: 'POST', path: '/api/teams/:slug/inbox/items/:itemId/actions' } as const satisfies ApiRoute;
