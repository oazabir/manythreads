import type { PluginContext } from '@manythreads/sdk';
import { APPROVAL_RUN_TIMEOUT_MINUTES, ApprovalsApprovalResumedEvent } from '@manythreads/shared';
import { pushChanged } from './notify.ts';

/** Lapsed pending approvals and approved calls that never finished are swept every five minutes. */
export const SWEEP_QUEUE = 'approvals.sweep';

/** The sweep: a pending approval nobody decided in time lapses; an approved call that never finished is called failed (never re-run). */
export function registerSweepJob(ctx: PluginContext): void {
  ctx.jobs.register(
    SWEEP_QUEUE,
    async (_raw, tx, job) => {
      const expired = await tx.query<{ id: string; team_id: string }>(
        `UPDATE app.approvals SET status = 'expired', decided_at = now()
          WHERE status = 'pending' AND expires_at <= now() RETURNING id, team_id`,
      );
      const stuck = await tx.query<{ id: string; workspace_id: string; team_id: string; source: string; tool: string; bot_id: string | null; was: string }>(
        `WITH stuck AS (
             SELECT a.id, a.outcome AS was FROM app.approvals a
              WHERE a.status = 'approved' AND a.outcome IN ('queued', 'running')
                AND coalesce(a.started_at, a.decided_at) < now() - make_interval(mins => $1)
                -- not one that is waiting, by design, for the run that asked to end (execute re-checks until that run's own deadline, which can
                -- be longer than the sweep's threshold): while that run is still going the call has not stalled. The reaper ends a run whose
                -- worker died, and from then on the usual threshold applies.
                AND NOT (a.run_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM app.bot_runs r WHERE r.id = a.run_id AND r.status = 'running' AND r.ended_at IS NULL AND r.started_at > now() - interval '1 day'))
              FOR UPDATE OF a)
           UPDATE app.approvals a SET outcome = 'failed',
                  outcome_detail = CASE WHEN s.was = 'running'
                    THEN 'It started but never reported back; it may or may not have been made. Check before asking again.'
                    ELSE 'It was approved but never started.' END
             FROM stuck s WHERE a.id = s.id
           RETURNING a.id, a.workspace_id, a.team_id, a.source, a.tool, a.bot_id, s.was`,
        [APPROVAL_RUN_TIMEOUT_MINUTES],
      );
      for (const row of stuck.rows) {
        await ctx.audit.emit(
          tx,
          ApprovalsApprovalResumedEvent.parse({
            type: 'approvals.approval.resumed',
            schemaVersion: 1,
            workspaceId: row.workspace_id,
            teamId: row.team_id,
            approvalId: row.id,
            source: row.source,
            tool: row.tool,
            botId: row.bot_id,
            outcome: 'failed',
            detail: row.was === 'running' ? 'Never reported back.' : 'Never started.',
          }),
        );
      }
      for (const row of [...expired.rows, ...stuck.rows]) await pushChanged(ctx, tx, row.id);
      if (expired.rows.length + stuck.rows.length > 0) job.log.info(`approvals: swept ${expired.rows.length} lapsed and ${stuck.rows.length} unfinished`);
    },
    { cron: '*/5 * * * *', maxAttempts: 1 },
  );
}
