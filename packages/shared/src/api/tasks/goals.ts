import { z } from 'zod';
import { Goal, GoalStatus } from '../../entities/task.ts';
import { GoalId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

export const ListGoalsPathParams = z.object({ slug: TeamSlug });
export type ListGoalsPathParams = z.infer<typeof ListGoalsPathParams>;

export const ListGoalsQuery = z.strictObject({
  status: GoalStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListGoalsQuery = z.infer<typeof ListGoalsQuery>;

export const ListGoalsResponse = z.object({ items: z.array(Goal) });
export type ListGoalsResponse = z.infer<typeof ListGoalsResponse>;
export const listGoalsRoute = { method: 'GET', path: '/api/teams/:slug/goals' } as const;

export const CreateGoalRequest = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
});
export type CreateGoalRequest = z.infer<typeof CreateGoalRequest>;
export const CreateGoalResponse = z.object({ goal: Goal });
export type CreateGoalResponse = z.infer<typeof CreateGoalResponse>;
export const createGoalRoute = { method: 'POST', path: '/api/teams/:slug/goals' } as const;

export const GoalPathParams = z.object({ slug: TeamSlug, goalId: GoalId });
export type GoalPathParams = z.infer<typeof GoalPathParams>;

/** `done` and `dropped` are final: a card cannot be attached to a closed goal afterwards. */
export const UpdateGoalRequest = z.strictObject({ status: GoalStatus.optional() });
export type UpdateGoalRequest = z.infer<typeof UpdateGoalRequest>;
export const UpdateGoalResponse = z.object({ goal: Goal });
export type UpdateGoalResponse = z.infer<typeof UpdateGoalResponse>;
export const updateGoalRoute = { method: 'PATCH', path: '/api/teams/:slug/goals/:goalId' } as const;
