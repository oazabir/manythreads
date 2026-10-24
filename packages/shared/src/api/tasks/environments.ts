import { z } from 'zod';
import { DeployWindow, Environment } from '../../entities/task.ts';
import { EnvironmentId, TaskId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

export const ListEnvironmentsPathParams = z.object({ slug: TeamSlug });
export type ListEnvironmentsPathParams = z.infer<typeof ListEnvironmentsPathParams>;

export const ListEnvironmentsResponse = z.object({ items: z.array(Environment) });
export type ListEnvironmentsResponse = z.infer<typeof ListEnvironmentsResponse>;
export const listEnvironmentsRoute = { method: 'GET', path: '/api/teams/:slug/environments' } as const;

/** Windows are validated as a set: none may start at or after its end (a window that crosses midnight is written as two). */
export const CreateEnvironmentRequest = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    protected: z.boolean().default(false),
    needsApproval: z.boolean().default(false),
    windows: z.array(DeployWindow).max(14).default([]),
    deployCap: z.number().int().min(1).max(1000).nullable().default(null),
    autoRollback: z.boolean().default(true),
    credentialRef: z.string().trim().max(200).default(''),
  })
  .superRefine((v, ctx) => {
    for (const [i, w] of v.windows.entries()) {
      if (w.from >= w.to) ctx.addIssue({ code: 'custom', path: ['windows', i], message: 'a window must end after it starts' });
    }
  });
export type CreateEnvironmentRequest = z.infer<typeof CreateEnvironmentRequest>;

export const CreateEnvironmentResponse = z.object({ environment: Environment });
export type CreateEnvironmentResponse = z.infer<typeof CreateEnvironmentResponse>;
export const createEnvironmentRoute = { method: 'POST', path: '/api/teams/:slug/environments' } as const;

export const EnvironmentPathParams = z.object({ slug: TeamSlug, environmentId: EnvironmentId });
export type EnvironmentPathParams = z.infer<typeof EnvironmentPathParams>;

export const UpdateEnvironmentRequest = z
  .strictObject({
    protected: z.boolean().optional(),
    needsApproval: z.boolean().optional(),
    windows: z.array(DeployWindow).max(14).optional(),
    deployCap: z.number().int().min(1).max(1000).nullable().optional(),
    autoRollback: z.boolean().optional(),
    credentialRef: z.string().trim().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    for (const [i, w] of (v.windows ?? []).entries()) {
      if (w.from >= w.to) ctx.addIssue({ code: 'custom', path: ['windows', i], message: 'a window must end after it starts' });
    }
  });
export type UpdateEnvironmentRequest = z.infer<typeof UpdateEnvironmentRequest>;
export const UpdateEnvironmentResponse = z.object({ environment: Environment });
export type UpdateEnvironmentResponse = z.infer<typeof UpdateEnvironmentResponse>;
export const updateEnvironmentRoute = { method: 'PATCH', path: '/api/teams/:slug/environments/:environmentId' } as const;

/**
 * Deploy a card's work. A `protected` environment (or one with `needsApproval`) answers `needs_approval` with the approval that waits;
 * outside its windows it answers `outside_window`; past the daily cap, `cap_reached`. Only `deployed` records a deploy.
 */
export const DeployRequest = z.strictObject({
  taskId: TaskId.optional(),
  summary: z.string().trim().max(300).default(''),
});
export type DeployRequest = z.infer<typeof DeployRequest>;

export const DeployOutcome = z.enum(['deployed', 'needs_approval', 'outside_window', 'cap_reached']);
export type DeployOutcome = z.infer<typeof DeployOutcome>;

export const DeployResponse = z.object({
  outcome: DeployOutcome,
  approvalId: z.uuid().nullable(),
  reason: z.string(),
});
export type DeployResponse = z.infer<typeof DeployResponse>;
export const deployEnvironmentRoute = { method: 'POST', path: '/api/teams/:slug/environments/:environmentId/deploy' } as const;
