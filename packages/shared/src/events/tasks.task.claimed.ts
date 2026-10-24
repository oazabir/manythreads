import { z } from 'zod';
import { ActorKind } from '../entities/kernel.ts';
import { ActorId, TaskId, TeamId, WorkspaceId } from '../ids.ts';

/** A card was claimed (one active claim per card, the partial unique index). `expiresAt` is when the sweep may release it. */
export const TasksTaskClaimedEvent = z.object({
  type: z.literal('tasks.task.claimed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  taskId: TaskId,
  actorId: ActorId,
  actorKind: ActorKind,
  expiresAt: z.string(),
});
export type TasksTaskClaimedEvent = z.infer<typeof TasksTaskClaimedEvent>;
