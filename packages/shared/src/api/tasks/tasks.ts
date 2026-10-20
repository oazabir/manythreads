import { z } from 'zod';
import { Handoff, Task, TaskEvent, TaskKind, TaskPriority, TaskState } from '../../entities/task.ts';
import { ActorId, EnvironmentId, GoalId, TaskId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

// The task board API (SPEC §8, PLAN P6-02). Every route is scoped to a team slug: the team the caller may read is the team the
// route answers about, so an id from another team is a 404, never a cross-team leak (the table policies say the same).

export const TaskPathParams = z.object({ slug: TeamSlug, taskId: TaskId });
export type TaskPathParams = z.infer<typeof TaskPathParams>;

export const ListTasksPathParams = z.object({ slug: TeamSlug });
export type ListTasksPathParams = z.infer<typeof ListTasksPathParams>;

/** Filters the board and the list share; unknown keys are refused (the client sends only these). */
export const ListTasksQuery = z.strictObject({
  state: TaskState.optional(),
  kind: TaskKind.optional(),
  priority: TaskPriority.optional(),
  goalId: GoalId.optional(),
  ownerId: ActorId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuery>;

export const ListTasksResponse = z.object({
  items: z.array(Task),
  total: z.number().int().nonnegative(),
});
export type ListTasksResponse = z.infer<typeof ListTasksResponse>;
export const listTasksRoute = { method: 'GET', path: '/api/teams/:slug/tasks' } as const;

export const CreateTaskRequest = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).default(''),
  kind: TaskKind.default('code'),
  priority: TaskPriority.default('normal'),
  branch: z.string().trim().min(1).max(200),
  goalId: GoalId.optional(),
  environmentId: EnvironmentId.optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const CreateTaskResponse = z.object({ task: Task });
export type CreateTaskResponse = z.infer<typeof CreateTaskResponse>;
export const createTaskRoute = { method: 'POST', path: '/api/teams/:slug/tasks' } as const;

export const GetTaskResponse = z.object({ task: Task });
export type GetTaskResponse = z.infer<typeof GetTaskResponse>;
export const getTaskRoute = { method: 'GET', path: '/api/teams/:slug/tasks/:taskId' } as const;

/** A direct edit. `state` follows the transition table; moving a `code` card to `done` needs a `testedSha` on the card. */
export const UpdateTaskRequest = z.strictObject({
  state: TaskState.optional(),
  priority: TaskPriority.optional(),
  blockerReason: z.string().trim().max(500).optional(),
  testedSha: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;
export const UpdateTaskResponse = z.object({ task: Task });
export type UpdateTaskResponse = z.infer<typeof UpdateTaskResponse>;
export const updateTaskRoute = { method: 'PATCH', path: '/api/teams/:slug/tasks/:taskId' } as const;

/** One claim per card: the second caller answers 409 `already_owned` and changes nothing. */
export const ClaimTaskResponse = z.object({ task: Task, expiresAt: z.string() });
export type ClaimTaskResponse = z.infer<typeof ClaimTaskResponse>;
export const claimTaskRoute = { method: 'POST', path: '/api/teams/:slug/tasks/:taskId/claim' } as const;

export const ReleaseTaskResponse = z.object({ task: Task });
export type ReleaseTaskResponse = z.infer<typeof ReleaseTaskResponse>;
export const releaseTaskRoute = { method: 'POST', path: '/api/teams/:slug/tasks/:taskId/release' } as const;

/**
 * Done, with the freshness facts: `testedSha` is the commit that was tested, `branchHeadSha` is where the branch is now. A `code` card
 * without a tested sha, or one whose base moved, is refused with the reason on the card (PLAN P6-04).
 */
export const CompleteTaskRequest = z.strictObject({
  testedSha: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
  branchHeadSha: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
  summary: z.string().trim().max(1000).default(''),
});
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequest>;
export const CompleteTaskResponse = z.object({ task: Task });
export type CompleteTaskResponse = z.infer<typeof CompleteTaskResponse>;
export const completeTaskRoute = { method: 'POST', path: '/api/teams/:slug/tasks/:taskId/complete' } as const;

/** Send the work back to `in_progress` and count the rework; past the bound a person has to look at it. */
export const ReworkTaskRequest = z.strictObject({ reason: z.string().trim().max(500).default('') });
export type ReworkTaskRequest = z.infer<typeof ReworkTaskRequest>;
export const ReworkTaskResponse = z.object({ task: Task });
export type ReworkTaskResponse = z.infer<typeof ReworkTaskResponse>;
export const reworkTaskRoute = { method: 'POST', path: '/api/teams/:slug/tasks/:taskId/rework' } as const;

/**
 * Move the card to another owner. Exactly one of `toActorId` / `toBotSlug` names the target. `strict` waits for an approval first
 * (`dispatch: strict`, SPEC §7.3): the handover is filed and the card does not move until somebody else approves it.
 */
export const HandoffTaskRequest = z
  .strictObject({
    toActorId: ActorId.optional(),
    toBotSlug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
    mode: z.enum(['bot', 'person']),
    note: z.string().trim().max(1000).default(''),
    strict: z.boolean().default(false),
  })
  .refine((v) => (v.toActorId === undefined) !== (v.toBotSlug === undefined), 'name exactly one target: toActorId or toBotSlug');
export type HandoffTaskRequest = z.infer<typeof HandoffTaskRequest>;

export const HandoffTaskResponse = z.object({
  task: Task,
  handoff: Handoff,
  /** True when the handover is filed and waits for a person (`dispatch: strict`). */
  pendingApproval: z.boolean(),
  approvalId: z.uuid().nullable(),
});
export type HandoffTaskResponse = z.infer<typeof HandoffTaskResponse>;
export const handoffTaskRoute = { method: 'POST', path: '/api/teams/:slug/tasks/:taskId/handoff' } as const;

export const ListTaskEventsResponse = z.object({ items: z.array(TaskEvent) });
export type ListTaskEventsResponse = z.infer<typeof ListTaskEventsResponse>;
export const listTaskEventsRoute = { method: 'GET', path: '/api/teams/:slug/tasks/:taskId/events' } as const;
