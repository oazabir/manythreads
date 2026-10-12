import { z } from 'zod';
import { ApprovalSource } from '../entities/approval.ts';
import { ApprovalId, BotId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * What became of an approved call: the stopped tool call ran as its bot (`ran`), or the stopped job went back on its queue (`ran` as well: the
 * queue owns the rest), or it could not be done (`failed`: the grant is gone, the tool refused). The reason is a sentence without arguments.
 */
export const ApprovalsApprovalResumedEvent = z.object({
  type: z.literal('approvals.approval.resumed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  approvalId: ApprovalId,
  source: ApprovalSource,
  tool: z.string().min(1),
  botId: BotId.nullable(),
  outcome: z.enum(['ran', 'failed']),
  detail: z.string(),
});
export type ApprovalsApprovalResumedEvent = z.infer<typeof ApprovalsApprovalResumedEvent>;
