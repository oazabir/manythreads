import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ShareCounts, ShareExclusionReason, ShareId, ShareRunId, ShareRunState, ShareRunTrigger, ShareSlug } from '../entities/share.ts';
import { ActorId, ApprovalId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A share run finished building (PLAN P8-23): the digest is ready for a person (`awaiting_approval`) or to go (`ready`), there was nothing new to send
 * (`empty`), or it could not be built or was stopped (`blocked`, `failed`). This is also the "what was withheld" record: `withheld` counts the concepts
 * left out of the digest by reason. Ids, counts and reason codes only: never a path, a title or any text of a concept.
 */
export const MemoryShareBuiltEvent = z.object({
  type: z.literal('memory.share.built'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  shareId: ShareId,
  slug: ShareSlug,
  runId: ShareRunId,
  trigger: ShareRunTrigger,
  state: ShareRunState,
  counts: ShareCounts.nullable(),
  /** How many concepts were left out for each reason. */
  withheld: z.partialRecord(ShareExclusionReason, z.number().int().min(1)),
  destinations: z.number().int().min(0),
  approvalId: ApprovalId.nullable(),
  requestedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MemoryShareBuiltEvent = z.infer<typeof MemoryShareBuiltEvent>;
