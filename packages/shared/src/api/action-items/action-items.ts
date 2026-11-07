import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { FileId, TaskId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// P20-12: the person's own action items, `Action items/action-items.md` in their Personal space (okf/action-items-file.ts has the line form). The list view reads
// and edits that one file; every change is a new version of it, so nothing is lost. A card on a board is made by the web as the person (the tasks API) and
// recorded here, the same way the memory inbox does it.

export const ActionItemView = z.object({
  /** A handle for the line, made from its words; it changes when the words change, so a stale edit is refused. */
  id: z.string().regex(/^[0-9a-f]{8}(-\d+)?$/),
  what: z.string().min(1).max(500),
  owner: z.string().max(120).nullable(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  done: z.boolean(),
  source: z.string().max(300).nullable(),
  /** What happened to it, oldest first. */
  why: z.array(z.string().max(500)).max(50),
  cardTaskId: TaskId.nullable(),
});
export type ActionItemView = z.infer<typeof ActionItemView>;

export const ListActionItemsResponse = z.object({
  items: z.array(ActionItemView).max(200),
  /** The file behind the list; null until the first item is saved. */
  fileId: FileId.nullable(),
  /** A token for the file as read; send it back with an edit. It changes with every save of the file, by anyone. */
  revision: z.string().max(100).nullable(),
  updatedAt: IsoDateTime.nullable(),
  /** The routine that keeps the list up to date, if the person has switched it on. */
  keeperRoutineId: z.uuid().nullable(),
});
export type ListActionItemsResponse = z.infer<typeof ListActionItemsResponse>;
export const listActionItemsRoute = { method: 'GET', path: '/api/me/action-items' } as const satisfies ApiRoute;

const Due = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-11-20');

/** One change. `revision` is what the list was read at: a save made since then is a 409 and the screen reloads. */
export const ChangeActionItemRequest = z.strictObject({
  revision: z.string().max(100).nullable(),
  change: z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('tick'), id: z.string().max(20), done: z.boolean() }),
    z.strictObject({ op: z.literal('edit'), id: z.string().max(20), what: z.string().trim().min(1).max(500).optional(), owner: z.string().trim().max(120).nullable().optional(), due: Due.nullable().optional() }),
    z.strictObject({ op: z.literal('add'), what: z.string().trim().min(1).max(500), owner: z.string().trim().max(120).nullable().optional(), due: Due.nullable().optional() }),
    z.strictObject({ op: z.literal('card'), id: z.string().max(20), taskId: TaskId }),
  ]),
});
export type ChangeActionItemRequest = z.infer<typeof ChangeActionItemRequest>;
export const ChangeActionItemResponse = z.object({ list: ListActionItemsResponse, id: z.string() });
export type ChangeActionItemResponse = z.infer<typeof ChangeActionItemResponse>;
export const changeActionItemRoute = { method: 'PATCH', path: '/api/me/action-items' } as const satisfies ApiRoute;
