import { z } from 'zod';
import { ApprovalSource } from '../entities/approval.ts';
import { ActorId, ApprovalId, BotId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A call is waiting for a person (SPEC §7.3, PLAN P5-20): the one handler for `needsApproval` wrote a pending approval, whichever of the four sources
 * set it. Carries ids and the capability name, never the arguments (they are on the row, behind its row level security).
 */
export const ApprovalsApprovalRequestedEvent = z.object({
  type: z.literal('approvals.approval.requested'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  approvalId: ApprovalId,
  source: ApprovalSource,
  tool: z.string().min(1),
  botId: BotId.nullable(),
  runId: RunId.nullable(),
  requesterId: ActorId,
});
export type ApprovalsApprovalRequestedEvent = z.infer<typeof ApprovalsApprovalRequestedEvent>;
