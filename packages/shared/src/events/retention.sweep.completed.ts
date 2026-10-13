import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { RetentionCounts } from '../entities/retention.ts';
import { WorkspaceId } from '../ids.ts';

/**
 * A retention sweep finished for a workspace (PLAN P5-14): run logs older than the workspace's window were pruned (or, in a dry run, counted).
 * Carries the cutoffs and counts, never an id or a line of what was removed. It is an audit event like any other and is itself never pruned:
 * the answer to "what did retention delete, and when" outlives what it deleted.
 */
export const RetentionSweepCompletedEvent = z.object({
  type: z.literal('retention.sweep.completed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  sweepId: z.uuid(),
  dryRun: z.boolean(),
  runLogCutoff: IsoDateTime,
  memoryLogCutoff: IsoDateTime,
  counts: RetentionCounts,
  durationMs: z.number().int().nonnegative(),
});
export type RetentionSweepCompletedEvent = z.infer<typeof RetentionSweepCompletedEvent>;
