import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxHoldReason, InboxItemId } from '../entities/inbox.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** A lead or admin released a held inbox item into the pipeline (PLAN P8-17). `reason` is the rule that had held it. */
export const MemoryItemReleasedEvent = z.object({
  type: z.literal('memory.item.released'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  itemId: InboxItemId,
  reason: InboxHoldReason.nullable(),
  releasedBy: ActorId,
  at: IsoDateTime,
});
export type MemoryItemReleasedEvent = z.infer<typeof MemoryItemReleasedEvent>;
