import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ShareId, ShareRunId, ShareSlug } from '../entities/share.ts';
import { ActorId, ApprovalId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A person decided a digest (PLAN P8-23): `ready` (approved, waiting to be delivered), `denied`, or `expired` (nobody decided in time). Ids only.
 */
export const MemoryShareSettledEvent = z.object({
  type: z.literal('memory.share.settled'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  shareId: ShareId,
  slug: ShareSlug,
  runId: ShareRunId,
  outcome: z.enum(['ready', 'denied', 'expired']),
  approvalId: ApprovalId,
  decidedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MemoryShareSettledEvent = z.infer<typeof MemoryShareSettledEvent>;
