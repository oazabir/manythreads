import { z } from 'zod';
import { TaskKind } from '../entities/task.ts';
import { ActorId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/** A card reached `done`. `testedSha` is the commit that was tested (required for `code` work). */
export const TasksTaskCompletedEvent = z.object({
  type: z.literal('tasks.task.completed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  taskId: TaskId,
  kind: TaskKind,
  actorId: ActorId,
  testedSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
});
export type TasksTaskCompletedEvent = z.infer<typeof TasksTaskCompletedEvent>;
