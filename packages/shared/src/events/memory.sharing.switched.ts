import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/** A workspace owner or admin switched "Memory sharing" on or off (PLAN P8-24). Off, no team sends a digest and none is delivered. */
export const MemorySharingSwitchedEvent = z.object({
  type: z.literal('memory.sharing.switched'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  enabled: z.boolean(),
  changedBy: ActorId,
  at: IsoDateTime,
});
export type MemorySharingSwitchedEvent = z.infer<typeof MemorySharingSwitchedEvent>;
