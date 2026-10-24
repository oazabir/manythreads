import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { TasksTaskCompletedEvent, TasksTaskHandedOffEvent, TasksTaskUpdatedEvent, type Handoff, type Task } from '@manythreads/shared';

/** Emit `tasks.task.updated`, the one event a board, a thread and a runtime watch. */
export async function emitUpdated(ctx: PluginContext, tx: PluginTx, before: Task, after: Task): Promise<void> {
  await ctx.audit.emit(
    tx,
    TasksTaskUpdatedEvent.parse({
      type: 'tasks.task.updated',
      schemaVersion: 1,
      workspaceId: after.workspaceId,
      teamId: after.teamId,
      taskId: after.id,
      state: after.state,
      fromState: before.state,
      kind: after.kind,
      ownerId: after.ownerId,
      testedSha: after.testedSha,
      actorId: tx.actor.id,
    }),
  );
}

/** Emit `tasks.task.handed_off` for a handover that took effect (the route and the `tasks.handoff` tool share it). */
export async function emitHandedOff(ctx: PluginContext, tx: PluginTx, after: Task, handoff: Handoff): Promise<void> {
  await ctx.audit.emit(
    tx,
    TasksTaskHandedOffEvent.parse({
      type: 'tasks.task.handed_off',
      schemaVersion: 1,
      workspaceId: after.workspaceId,
      teamId: after.teamId,
      taskId: after.id,
      handoffId: handoff.id,
      fromActorId: handoff.fromActorId,
      toActorId: handoff.toActorId,
      mode: handoff.mode,
      approvalId: handoff.approvalId,
      note: handoff.note,
    }),
  );
}

/** Emit `tasks.task.completed` (the route and the `tasks.complete` tool share it). */
export async function emitCompleted(ctx: PluginContext, tx: PluginTx, after: Task): Promise<void> {
  await ctx.audit.emit(
    tx,
    TasksTaskCompletedEvent.parse({
      type: 'tasks.task.completed',
      schemaVersion: 1,
      workspaceId: after.workspaceId,
      teamId: after.teamId,
      taskId: after.id,
      kind: after.kind,
      actorId: tx.actor.id,
      testedSha: after.testedSha,
    }),
  );
}
