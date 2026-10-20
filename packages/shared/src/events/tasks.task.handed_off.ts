import { z } from 'zod';
import { HandoffMode } from '../entities/task.ts';
import { ActorId, HandoffId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A card changed hands (PLAN P6-03). Emitted when the handover takes effect: at once for an ordinary handoff, or when the approval a
 * `dispatch: strict` handover waited on is approved. `approvalId` is set in the strict case only.
 */
export const TasksTaskHandedOffEvent = z.object({
  type: z.literal('tasks.task.handed_off'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  taskId: TaskId,
  handoffId: HandoffId,
  fromActorId: ActorId,
  toActorId: ActorId,
  mode: HandoffMode,
  approvalId: z.uuid().nullable(),
  note: z.string().max(1000),
});
export type TasksTaskHandedOffEvent = z.infer<typeof TasksTaskHandedOffEvent>;
