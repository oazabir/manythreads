import { z } from 'zod';
import { TaskKind, TaskPriority, TaskState } from '../entities/task.ts';
import { ActorId, GoalId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/** A card was created (PLAN P6-02). Carries ids and the fields the board filters on, never the description. */
export const TasksTaskCreatedEvent = z.object({
  type: z.literal('tasks.task.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  taskId: TaskId,
  goalId: GoalId.nullable(),
  state: TaskState,
  kind: TaskKind,
  priority: TaskPriority,
  creatorId: ActorId,
});
export type TasksTaskCreatedEvent = z.infer<typeof TasksTaskCreatedEvent>;
