import { z } from 'zod';
import { TaskKind, TaskState } from '../entities/task.ts';
import { ActorId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A card changed: its state, its owner or its freshness facts. The one event a board, a thread and a runtime watch (`task.updated`,
 * SPEC §8). `fromState` is null on the first write of a state (nothing changed it before).
 */
export const TasksTaskUpdatedEvent = z.object({
  type: z.literal('tasks.task.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  taskId: TaskId,
  state: TaskState,
  fromState: TaskState.nullable(),
  kind: TaskKind,
  ownerId: ActorId.nullable(),
  testedSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  actorId: ActorId,
});
export type TasksTaskUpdatedEvent = z.infer<typeof TasksTaskUpdatedEvent>;
