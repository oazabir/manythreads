import { z } from 'zod';
import { ApprovalDecisionKind, ApprovalSource } from '../entities/approval.ts';
import { ActorId, ApprovalId, BotId, TeamId, WorkspaceId } from '../ids.ts';

/** A person approved or denied a pending approval. Never the requester (the decide function refuses that), and exactly once per approval. */
export const ApprovalsApprovalDecidedEvent = z.object({
  type: z.literal('approvals.approval.decided'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  approvalId: ApprovalId,
  source: ApprovalSource,
  tool: z.string().min(1),
  botId: BotId.nullable(),
  requesterId: ActorId,
  deciderId: ActorId,
  decision: ApprovalDecisionKind,
});
export type ApprovalsApprovalDecidedEvent = z.infer<typeof ApprovalsApprovalDecidedEvent>;
