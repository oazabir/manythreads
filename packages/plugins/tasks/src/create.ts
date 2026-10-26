import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { TasksTaskCreatedEvent, type Task } from '@manythreads/shared';
import { toTask, type TaskRow } from './rows.ts';

/**
 * The one door that writes a new card: `app.tasks_create` makes the row and its `created` history in one statement, and the caller emits
 * `tasks.task.created` in the same transaction, so a card and its timeline cannot disagree. The route (`POST /tasks`) and the
 * `tasks.create` tool both come through here; each keeps its own checks in front of it, because a person naming a team answers 404 and a
 * run naming none is confined to its bot's team.
 */
export interface NewCard {
  workspaceId: string;
  teamId: string;
  goalId: string | null;
  title: string;
  description: string;
  kind: string;
  priority: string;
  branch: string;
  environmentId: string | null;
  /** A board of the same team (the door checks it); null files the card on none. */
  boardId?: string | null;
  actorId: string;
}

export async function insertCard(ctx: PluginContext, tx: PluginTx, card: NewCard): Promise<Task> {
  const row = (
    await tx.query<TaskRow>('SELECT * FROM app.tasks_create($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::uuid, $10::uuid, $11::uuid)', [
      card.workspaceId,
      card.teamId,
      card.goalId,
      card.title,
      card.description,
      card.kind,
      card.priority,
      card.branch,
      card.environmentId,
      card.actorId,
      card.boardId ?? null,
    ])
  ).rows[0];
  if (!row) throw new Error('app.tasks_create wrote no card');
  const task = toTask(row);
  await ctx.audit.emit(
    tx,
    TasksTaskCreatedEvent.parse({
      type: 'tasks.task.created',
      schemaVersion: 1,
      workspaceId: task.workspaceId,
      teamId: task.teamId,
      taskId: task.id,
      goalId: task.goalId,
      state: task.state,
      kind: task.kind,
      priority: task.priority,
      creatorId: card.actorId,
    }),
  );
  return task;
}
