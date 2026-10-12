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
  approver_scope: unknown;
  requester_id: string;
  requester_name: string;
  bot_id: string | null;
  bot_slug: string | null;
  bot_name: string | null;
  channel_id: string | null;
  thread_root_id: string | null;
  created_at: Date;
  block_reason: string | null;
  decision: string | null;
  decision_note: string | null;
  decision_at: Date | null;
  decider_id: string | null;
  decider_name: string | null;
}

/**
 * The columns the app role may read (never `resume`), the names joined in, whether the caller may decide it (the database answers, see
 * `app.approvals_block_reason`) and the decision that settled it. Append a `WHERE` and an `ORDER BY`.
 */
export const APPROVAL_SELECT = `
  SELECT a.id, a.workspace_id, a.team_id, a.source, a.status, a.outcome, a.outcome_detail, a.tool, a.summary, a.args_preview, a.approver_scope,
         a.requester_id, coalesce(rp.display_name, rb.name, 'someone') AS requester_name,
         a.bot_id, b.slug AS bot_slug, b.name AS bot_name, a.channel_id, a.thread_root_id, a.created_at,
         app.approvals_block_reason(a.id) AS block_reason,
         d.decision, d.note AS decision_note, d.decided_at AS decision_at, d.decider_id, coalesce(dp.display_name, 'someone') AS decider_name
    FROM app.approvals a
    LEFT JOIN app.bots b ON b.id = a.bot_id
    JOIN app.actors ra ON ra.id = a.requester_id
    LEFT JOIN app.people rp ON rp.id = ra.ref_id AND ra.kind = 'person'
    LEFT JOIN app.bots rb ON rb.id = ra.ref_id AND ra.kind = 'bot'
    LEFT JOIN app.approval_decisions d ON d.approval_id = a.id
    LEFT JOIN app.actors da ON da.id = d.decider_id
    LEFT JOIN app.people dp ON dp.id = da.ref_id AND da.kind = 'person'`;

/** The one place an `approvals` row becomes the shared `Approval`. */
export function toApproval(r: ApprovalRow): Approval {
  const pending = r.status === 'pending';
  const block = r.block_reason === 'requester' || r.block_reason === 'not_approver' ? r.block_reason : null;
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
    botId: r.bot_id,
    botSlug: r.bot_slug,
    botName: r.bot_name,
    requesterId: r.requester_id,
    requesterName: r.requester_name,
    channelId: r.channel_id,
    threadRootId: r.thread_root_id,
    approvers: ApprovalApprovers.parse(r.approver_scope),
    canDecide: pending && r.block_reason === null,
    blockReason: pending ? block : null,
    decision:
      r.decision !== null && r.decision_at !== null && r.decider_id !== null
        ? { decision: r.decision, deciderId: r.decider_id, deciderName: r.decider_name ?? 'someone', note: r.decision_note ?? '', decidedAt: r.decision_at.toISOString() }
        : null,
    createdAt: r.created_at.toISOString(),
  });
}
