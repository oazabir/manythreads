import { z } from 'zod';
import { Runner, RunnerCapability, RunnerStatus } from '../../entities/task.ts';
import { RunnerId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

export const ListRunnersPathParams = z.object({ slug: TeamSlug });
export type ListRunnersPathParams = z.infer<typeof ListRunnersPathParams>;

export const ListRunnersResponse = z.object({ items: z.array(Runner) });
export type ListRunnersResponse = z.infer<typeof ListRunnersResponse>;
export const listRunnersRoute = { method: 'GET', path: '/api/teams/:slug/runners' } as const;

/**
 * The runner's own registration/heartbeat door (P6-06): a runner process presents a team token and says what it can do. Upsert by
 * `(team, name)`, so a restart is the same runner and no ghost row is left online.
 */
export const RegisterRunnerRequest = z.strictObject({
  name: z.string().trim().min(1).max(80),
  capabilities: z.array(RunnerCapability).max(32).default([]),
});
export type RegisterRunnerRequest = z.infer<typeof RegisterRunnerRequest>;

export const RegisterRunnerResponse = z.object({ runner: Runner });
export type RegisterRunnerResponse = z.infer<typeof RegisterRunnerResponse>;
export const registerRunnerRoute = { method: 'POST', path: '/api/teams/:slug/runners' } as const;

export const RunnerPathParams = z.object({ slug: TeamSlug, runnerId: RunnerId });
export type RunnerPathParams = z.infer<typeof RunnerPathParams>;

/** `offline` when the process goes away cleanly; the heartbeat sweep marks one silent for 90 s offline too. */
export const UpdateRunnerRequest = z.strictObject({
  status: RunnerStatus.optional(),
  capabilities: z.array(RunnerCapability).max(32).optional(),
});
export type UpdateRunnerRequest = z.infer<typeof UpdateRunnerRequest>;
export const UpdateRunnerResponse = z.object({ runner: Runner });
export type UpdateRunnerResponse = z.infer<typeof UpdateRunnerResponse>;
export const updateRunnerRoute = { method: 'PATCH', path: '/api/teams/:slug/runners/:runnerId' } as const;
