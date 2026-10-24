import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { ApprovalsApprovalDecidedEvent, RuntimeTaskNotWokenEvent, TasksTaskHandedOffEvent, TasksTaskUpdatedEvent } from '@manythreads/shared';
import { TASK_SELECT, toTask, type TaskRow } from './rows.ts';

/**
 * The other half of `dispatch: strict` and a protected deploy (PLAN P6-03, P6-05): when the approval is approved, the handover moves the
 * card and the deploy is recorded — each exactly once, latched by `handoffs.applied_at` / `deploy_requests.applied_at`. A denied approval
 * changes nothing (the card stays where it was). Runs as the system actor in the outbox consumer.
 */
export function registerApprovalSubscriber(ctx: PluginContext): void {
  ctx.events.subscribe('approvals.approval.decided', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ApprovalsApprovalDecidedEvent.parse(raw);
    if (event.decision !== 'approved') return;

    const applied = (
      await tx.query<{ o_handoff_id: string; o_task_id: string; o_team_id: string; o_workspace_id: string; o_from: string; o_to: string; o_mode: string; o_note: string }>(
        'SELECT * FROM app.tasks_apply_handoff($1::uuid)',
        [event.approvalId],
      )
    ).rows[0];
    if (applied) {
      const row = (await tx.query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1::uuid`, [applied.o_task_id])).rows[0];
      if (!row) return;
      const task = toTask(row);
      await ctx.audit.emit(
        tx,
        TasksTaskHandedOffEvent.parse({
          type: 'tasks.task.handed_off',
          schemaVersion: 1,
          workspaceId: applied.o_workspace_id,
          teamId: applied.o_team_id,
          taskId: applied.o_task_id,
          handoffId: applied.o_handoff_id,
          fromActorId: applied.o_from,
          toActorId: applied.o_to,
          mode: applied.o_mode,
          approvalId: event.approvalId,
          note: applied.o_note,
        }),
      );
      await ctx.audit.emit(
        tx,
        TasksTaskUpdatedEvent.parse({
          type: 'tasks.task.updated',
          schemaVersion: 1,
          workspaceId: task.workspaceId,
          teamId: task.teamId,
          taskId: task.id,
          state: task.state,
          fromState: null,
          kind: task.kind,
          ownerId: task.ownerId,
          testedSha: task.testedSha,
          actorId: event.deciderId,
        }),
      );
      return;
    }

    // A deploy request: approving it records the deploy in the ledger (and on the card), once.
    await tx.query('SELECT * FROM app.tasks_apply_deploy($1::uuid)', [event.approvalId]);
  });
}

/**
 * The runtime could not wake a bot for a card (`runtime.task.not_woken`): the miss goes on the card's history as a `not_woken` line with the
 * reason code, so a card that nobody picked up says why. The line is written once per event; the door ignores a card that is gone.
 */
export function registerNotWokenSubscriber(ctx: PluginContext): void {
  ctx.events.subscribe('runtime.task.not_woken', async (raw: PluginEvent, tx: PluginTx) => {
    const event = RuntimeTaskNotWokenEvent.parse(raw);
    await tx.query('SELECT app.tasks_note_event($1::uuid, $2, $3::jsonb)', [event.taskId, 'not_woken', JSON.stringify({ reason: event.reason })]);
  });
}
