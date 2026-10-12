import { NEVER_APPROVAL_GATED, NeverApprovalGatedError, NoEligibleApproverError, type ApprovalProvider, type ApprovalRequestInput, type PluginContext, type PluginTx } from '@manythreads/sdk';
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
      // The provider itself refuses what may never wait (SDK `NEVER_APPROVAL_GATED`, today `memory.retain`): an approved call is re-run in a NEW run
      // that has none of the first run's context, so a rule that reads the run's history would be decided blind. The SDK helper and the resume job
      // refuse too; this is the door that cannot be walked around, whoever calls it and with whatever source. Checked before anything is written.
      const resume = ApprovalResume.parse(input.resume);
      for (const tool of [input.tool, resume.kind === 'tool' ? resume.capability : null]) {
        if (tool !== null && NEVER_APPROVAL_GATED.includes(tool)) throw new NeverApprovalGatedError(tool);
      }
      type Filed = { o_id: string; o_created: boolean; o_workspace_id: string; o_team_id: string; o_bot_id: string; o_run_id: string; o_requester_id: string; o_private: boolean };
      let res: { rows: Filed[] };
      try {
        res = await tx.query<Filed>(
        'SELECT * FROM app.approvals_request($1::uuid, $2, $3, $4, $5::jsonb, $6::boolean, $7::jsonb, $8::text[], $9)',
        [
          input.runId,
          input.source,
          clip(input.tool, 200),
          clip(input.summary, 300),
          JSON.stringify(input.argsPreview),
          input.argsTruncated === true,
          JSON.stringify(resume),
          input.approvers === undefined ? null : [...input.approvers],
          input.dedupeKey === undefined ? null : clip(input.dedupeKey, 200),
        ],
        );
      } catch (err) {
        // AP001: the run is in a private conversation and nobody in it but the requester could decide this
        if ((err as { code?: string }).code === 'AP001') throw new NoEligibleApproverError();
        throw err;
      }
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
        await pushChanged(ctx, tx, row.o_id);
      }
      return { approvalId: row.o_id, created: row.o_created, visibleTo: row.o_private ? 'conversation' : 'team' };
    },

    async pendingForRun(tx: PluginTx, runId: string) {
      const res = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.approvals WHERE run_id = $1::uuid AND status = 'pending'", [runId]);
      return res.rows[0]?.n ?? 0;
    },

    async claim(tx: PluginTx, approvalId: string, expect) {
      // Only an event consumer's or a job's own (system) transaction takes a call back; the request role has no UPDATE on the table at all.
      if (tx.actor.kind !== 'system') return null;
      // One statement: the row is spent by the same UPDATE that reads it, so a replayed event finds nothing.
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
      await pushChanged(ctx, tx, approvalId);
      return row.payload;
    },
  };
}
