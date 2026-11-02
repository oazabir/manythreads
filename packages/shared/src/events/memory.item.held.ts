import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxHoldReason, InboxItemId, InboxOrigin } from '../entities/inbox.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * An inbox item was held (PLAN P8-14, P8-17): stored but never read by a model until a lead or admin releases or discards it. Nothing about the content;
 * `reason` is the short code of the rule that held it.
 */
export const MemoryItemHeldEvent = z.object({
  type: z.literal('memory.item.held'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  itemId: InboxItemId,
  origin: InboxOrigin,
  reason: InboxHoldReason,
  droppedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MemoryItemHeldEvent = z.infer<typeof MemoryItemHeldEvent>;
