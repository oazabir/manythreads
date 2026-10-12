import type { PluginTx } from '@manythreads/sdk';
import { Approval, ApprovalApprovers } from '@manythreads/shared';

/** An approval joined with the names a list shows, as `APPROVAL_SELECT` selects it. */
export interface ApprovalRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  source: string;
  status: string;
  outcome: string;
  outcome_detail: string;
  tool: string;
  summary: string;
  args_preview: Record<string, unknown>;
  args_truncated: boolean;
  expires_at: Date;
  started_at: Date | null;
  approver_scope: unknown;
  requester_id: string;
  requester_name: string;
  bot_id: string | null;
  bot_slug: string | null;
  bot_name: string | null;
  channel_id: string | null;
  thread_root_id: string | null;
  created_at: Date;
  decision: string | null;
  decision_note: string | null;
  decision_at: Date | null;
  decider_id: string | null;
  decider_name: string | null;
}

/**
 * The columns the app role may read (never `resume`) and the decision that settled it. Append a `WHERE` and an `ORDER BY`; whether the caller
 * may decide each one comes from `blockReasonsOf`, computed once for the whole list.
 */
export const APPROVAL_SELECT = `
  SELECT a.id, a.workspace_id, a.team_id, a.source, a.status, a.outcome, a.outcome_detail, a.tool, a.summary, a.args_preview, a.args_truncated, a.expires_at, a.started_at, a.approver_scope,
         a.requester_id, a.requester_name,
         a.bot_id, b.slug AS bot_slug, b.name AS bot_name, a.channel_id, a.thread_root_id, a.created_at,
         d.decision, d.note AS decision_note, d.decided_at AS decision_at, d.decider_id, d.decider_name
    FROM app.approvals a
    LEFT JOIN app.bots b ON b.id = a.bot_id
    LEFT JOIN app.approval_decisions d ON d.approval_id = a.id`;

/** For each id: null when the caller may decide it now, else why not (`app.approvals_block_reasons`, set-wise: one pass for the whole list). */
export async function blockReasonsOf(tx: PluginTx, ids: readonly string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const res = await tx.query<{ o_id: string; o_reason: string | null }>('SELECT o_id, o_reason FROM app.approvals_block_reasons($1::uuid[])', [[...ids]]);
  return new Map(res.rows.map((r) => [r.o_id, r.o_reason]));
}

/** The one place an `approvals` row becomes the shared `Approval`; `blockReason` is what `blockReasonsOf` said for it (undefined: not visible). */
export function toApproval(r: ApprovalRow, blockReason: string | null | undefined): Approval {
  const pending = r.status === 'pending';
  const block = blockReason === 'requester' || blockReason === 'not_approver' ? blockReason : null;
  return Approval.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    source: r.source,
    status: r.status,
    outcome: r.outcome,
    outcomeDetail: r.outcome_detail,
    tool: r.tool,
    summary: r.summary,
    argsPreview: r.args_preview,
    argsTruncated: r.args_truncated,
    expiresAt: r.expires_at.toISOString(),
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    botId: r.bot_id,
    botSlug: r.bot_slug,
    botName: r.bot_name,
    requesterId: r.requester_id,
    requesterName: r.requester_name,
    channelId: r.channel_id,
    threadRootId: r.thread_root_id,
    approvers: ApprovalApprovers.parse(r.approver_scope),
    canDecide: pending && blockReason === null,
    blockReason: pending ? block : null,
    decision:
      r.decision !== null && r.decision_at !== null && r.decider_id !== null
        ? { decision: r.decision, deciderId: r.decider_id, deciderName: r.decider_name ?? 'someone', note: r.decision_note ?? '', decidedAt: r.decision_at.toISOString() }
        : null,
    createdAt: r.created_at.toISOString(),
  });
}
