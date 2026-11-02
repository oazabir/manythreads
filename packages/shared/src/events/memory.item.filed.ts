import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxItemId, InboxOrigin } from '../entities/inbox.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * An inbox item was filed into the team's memory (PLAN P8-14, P8-17): one commit with the concepts the Archivist proposed and the platform-built
 * reference. `concepts` counts every concept written, the reference included. Ids and counts only.
 */
export const MemoryItemFiledEvent = z.object({
  type: z.literal('memory.item.filed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  itemId: InboxItemId,
  origin: InboxOrigin,
  concepts: z.number().int().min(1),
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** Whether an Archivist (a model) distilled the concepts, or only the platform's reference was written. */
  distilled: z.boolean(),
  droppedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MemoryItemFiledEvent = z.infer<typeof MemoryItemFiledEvent>;
