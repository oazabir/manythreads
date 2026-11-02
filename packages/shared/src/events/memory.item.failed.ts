import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxItemId, InboxOrigin } from '../entities/inbox.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** The step of the pipeline that could not finish. */
export const InboxFailureStage = z.enum(['extract', 'distil', 'validate', 'commit']);
export type InboxFailureStage = z.infer<typeof InboxFailureStage>;

/** An inbox item could not be filed (PLAN P8-14, P8-17). The stage and the number of tries only: the plain-language reason is on the item, not in the log. */
export const MemoryItemFailedEvent = z.object({
  type: z.literal('memory.item.failed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  itemId: InboxItemId,
  origin: InboxOrigin,
  stage: InboxFailureStage,
  attempts: z.number().int().min(1),
  droppedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MemoryItemFailedEvent = z.infer<typeof MemoryItemFailedEvent>;
