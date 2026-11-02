import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxItemId, InboxKind, InboxOrigin } from '../entities/inbox.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * Something was dropped into a team's memory inbox (PLAN P8-14, SPEC §12.2): a file, a note, a link or a message. Ids, the origin, the kind and the size
 * only: never the file's name or its text. `duplicate` is true when the same bytes were already there, so nothing was queued.
 */
export const MemoryItemDroppedEvent = z.object({
  type: z.literal('memory.item.dropped'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  itemId: InboxItemId,
  origin: InboxOrigin,
  kind: InboxKind,
  size: z.number().int().min(0),
  teamOnly: z.boolean(),
  duplicate: z.boolean(),
  droppedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MemoryItemDroppedEvent = z.infer<typeof MemoryItemDroppedEvent>;
