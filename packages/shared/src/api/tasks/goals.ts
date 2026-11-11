import { z } from 'zod';
import { Goal, GoalStatus, GoalStep, MAX_GOAL_STEPS } from '../../entities/task.ts';
import { IsoDateTime } from '../../common/time.ts';
import { BoardId, GoalId, MessageId } from '../../ids.ts';
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
  /** What the goal may cost in US dollars; shown beside the spend, never enforced. */
  budgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
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

// The goal tools a bot calls (`goals.ensure`, `goals.plan`) and the read `tasks.goal` (also bound to a plan card on a screen) --------------------------

/** `goals.ensure`: the goal of the thread this run answers in. The channel and the thread come from the run, never from the model. */
export const GoalsEnsureInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  budgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
});
export type GoalsEnsureInput = z.infer<typeof GoalsEnsureInput>;

/** `goals.plan`: replaces the steps of a goal (one to twelve). */
export const GoalsPlanInput = z.strictObject({
  goalId: GoalId,
  steps: z.array(GoalStep).min(1).max(MAX_GOAL_STEPS),
});
export type GoalsPlanInput = z.infer<typeof GoalsPlanInput>;

/** `tasks.goal`: one goal's plan, read as the caller. */
export const TasksGoalInput = z.strictObject({ goalId: GoalId });
export type TasksGoalInput = z.infer<typeof TasksGoalInput>;

export const TasksGoalStep = z.object({
  title: z.string(),
  /** Display names of the bots, never slugs. */
  bots: z.array(z.string()),
  /** The words at the right of the step: `done`, `running`, `rework 1`, `waiting`, `blocked`, or empty for a step not started. */
  status: z.string(),
  dot: z.enum(['done', 'running', 'todo', 'blocked']),
  rework: z.number().int().min(0),
});
export type TasksGoalStep = z.infer<typeof TasksGoalStep>;

export const TasksGoalPlan = z.object({
  /** `G-27`. */
  ref: z.string(),
  title: z.string(),
  chip: z.enum(['planned', 'running', 'waiting for a person', 'done', 'stopped']),
  /** What the goal's runs cost so far; null when the caller cannot read it or no ledger exists. */
  spend: z.object({ usd: z.number().min(0), budgetUsd: z.number().min(0).nullable() }).nullable(),
  steps: z.array(TasksGoalStep).max(MAX_GOAL_STEPS),
  stepNow: z.number().int().min(0),
  stepCount: z.number().int().min(0),
  /** The goal's board in the web app; null when the caller cannot read it. The page builds the link from these two ids. */
  board: z.object({ teamSlug: TeamSlug, boardId: BoardId }).nullable(),
  /** The working thread; null when the goal has none or the caller cannot read it. */
  thread: z
    .object({
      rootId: MessageId,
      replies: z.number().int().min(0),
      lastName: z.string().nullable(),
      lastAt: IsoDateTime.nullable(),
      faces: z.array(z.string()).max(3),
    })
    .nullable(),
});
export type TasksGoalPlan = z.infer<typeof TasksGoalPlan>;

export const TasksGoalAnswer = z.object({ ok: z.literal(true), plan: TasksGoalPlan });
export type TasksGoalAnswer = z.infer<typeof TasksGoalAnswer>;
