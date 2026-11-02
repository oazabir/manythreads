import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxHoldReason, InboxItemId } from '../entities/inbox.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** A lead or admin threw an inbox item away (PLAN P8-17); its original was deleted. `reason` is the rule that had held it, if one had. */
export const MemoryItemDiscardedEvent = z.object({
  type: z.literal('memory.item.discarded'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  itemId: InboxItemId,
  reason: InboxHoldReason.nullable(),
  discardedBy: ActorId,
  at: IsoDateTime,
});
export type MemoryItemDiscardedEvent = z.infer<typeof MemoryItemDiscardedEvent>;
