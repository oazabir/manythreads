import type { ApprovalProvider, ApprovalRequestInput, PluginContext, PluginTx } from '@manythreads/sdk';
import { ApprovalResume, ApprovalsApprovalRequestedEvent, ApprovalsApprovalResumedEvent } from '@manythreads/shared';
import { pushChanged } from './notify.ts';

// The one handler for `needsApproval` (PLAN P5-20): the provider other plugins reach as `ctx.providers.get<ApprovalProvider>('approvals')`.
// The four sources differ only in the text and the resume they pass; everything after that — the row, who may decide, the event and the
// push — is this file and the two definer doors of migration 0001.

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createApprovalProvider(ctx: PluginContext): ApprovalProvider {
  return {
    id: 'approvals',

    async request(tx: PluginTx, input: ApprovalRequestInput) {
      const resume = ApprovalResume.parse(input.resume);
      const res = await tx.query<{ o_id: string; o_created: boolean; o_workspace_id: string; o_team_id: string; o_bot_id: string; o_run_id: string; o_requester_id: string }>(
        'SELECT * FROM app.approvals_request($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[], $8)',
        [
          input.runId,
          input.source,
          clip(input.tool, 200),
          clip(input.summary, 300),
          JSON.stringify(input.argsPreview),
          JSON.stringify(resume),
          input.approvers === undefined ? null : [...input.approvers],
          input.dedupeKey === undefined ? null : clip(input.dedupeKey, 200),
        ],
      );
      const row = res.rows[0];
      if (!row) throw new Error('the approval request answered no row');
      if (row.o_created) {
        // The facts come back from the door itself: a bot that is not (yet) on its team's roster could not read the row it just filed.
        await ctx.audit.emit(
          tx,
          ApprovalsApprovalRequestedEvent.parse({
            type: 'approvals.approval.requested',
            schemaVersion: 1,
            workspaceId: row.o_workspace_id,
            teamId: row.o_team_id,
            approvalId: row.o_id,
            source: input.source,
            tool: clip(input.tool, 200),
            botId: row.o_bot_id,
            runId: row.o_run_id,
            requesterId: row.o_requester_id,
          }),
        );
        await pushChanged(ctx, tx, row.o_team_id, row.o_id);
      }
      return { approvalId: row.o_id, created: row.o_created };
    },

    async pendingForRun(tx: PluginTx, runId: string) {
      const res = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.approvals WHERE run_id = $1::uuid AND status = 'pending'", [runId]);
      return res.rows[0]?.n ?? 0;
    },

    async claim(tx: PluginTx, approvalId: string, expect) {
      // One statement: the row is spent by the same UPDATE that reads it, so a replayed event finds nothing. Outside the system role the
      // table's policy lets the UPDATE match no row, which is the "false" the contract promises.
      const res = await tx.query<{ payload: Record<string, unknown>; workspace_id: string; team_id: string; source: string; tool: string; bot_id: string }>(
        `UPDATE app.approvals SET outcome = 'ran', outcome_detail = 'Taken back by the requester.'
          WHERE id = $1::uuid AND bot_id = $2::uuid AND source = $3 AND status = 'approved' AND outcome = 'queued' AND resume_kind = 'handoff'
        RETURNING resume -> 'payload' AS payload, workspace_id, team_id, source, tool, bot_id`,
        [approvalId, expect.botId, expect.source],
      );
      const row = res.rows[0];
      if (!row) return null;
      await ctx.audit.emit(
        tx,
        ApprovalsApprovalResumedEvent.parse({
          type: 'approvals.approval.resumed',
          schemaVersion: 1,
          workspaceId: row.workspace_id,
          teamId: row.team_id,
          approvalId,
          source: row.source,
          tool: row.tool,
          botId: row.bot_id,
          outcome: 'ran',
          detail: 'Taken back by the requester.',
        }),
      );
      await pushChanged(ctx, tx, row.team_id, approvalId);
      return row.payload;
    },
  };
}
