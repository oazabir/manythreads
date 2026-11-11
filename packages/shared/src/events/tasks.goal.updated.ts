import { z } from 'zod';
import { GoalStatus } from '../entities/task.ts';
import { ActorId, GoalId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A goal changed in a way its plan card shows: it was made (`created`), its steps were set (`planned`) or its status changed (`status`).
 * Ids, the goal's short number and counts only; never the title or the steps. A card of the goal moving is `tasks.task.updated`, not this.
 */
export const TasksGoalUpdatedEvent = z.object({
  type: z.literal('tasks.goal.updated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  goalId: GoalId,
  /** The goal's number within its team (the `27` of `G-27`). */
  number: z.number().int().positive(),
  change: z.enum(['created', 'planned', 'status']),
  status: GoalStatus,
  stepCount: z.number().int().min(0).max(12),
  actorId: ActorId,
});
export type TasksGoalUpdatedEvent = z.infer<typeof TasksGoalUpdatedEvent>;
