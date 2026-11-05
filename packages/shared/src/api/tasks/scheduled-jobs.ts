import { z } from 'zod';
import { CronExpression, ScheduledJob, ScheduledJobEffort, ScheduledJobKind, ScheduledJobRun } from '../../entities/scheduled-job.ts';
import { BotId, ScheduledJobId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

export const ListScheduledJobsPathParams = z.object({ slug: TeamSlug });
export type ListScheduledJobsPathParams = z.infer<typeof ListScheduledJobsPathParams>;

export const ListScheduledJobsResponse = z.object({ items: z.array(ScheduledJob) });
export type ListScheduledJobsResponse = z.infer<typeof ListScheduledJobsResponse>;
export const listScheduledJobsRoute = { method: 'GET', path: '/api/teams/:slug/scheduled-jobs' } as const;

/** One of `botId` / `botSlug` names the bot. A routine needs a contract path; a heartbeat and a task do not. */
export const CreateScheduledJobRequest = z
  .strictObject({
    botId: BotId.optional(),
    botSlug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
    name: z.string().trim().min(1).max(80),
    kind: ScheduledJobKind,
    schedule: CronExpression,
    modelAlias: z.string().trim().min(1).max(40).nullable().default(null),
    effort: ScheduledJobEffort.nullable().default(null),
    contractPath: z.string().trim().min(1).max(300).nullable().default(null),
    outputPath: z.string().trim().min(1).max(300).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .refine((v) => (v.botId === undefined) !== (v.botSlug === undefined), 'name exactly one bot: botId or botSlug')
  .refine((v) => v.kind !== 'routine' || v.contractPath !== null, 'a routine needs a contract path');
export type CreateScheduledJobRequest = z.infer<typeof CreateScheduledJobRequest>;
export const CreateScheduledJobResponse = z.object({ scheduledJob: ScheduledJob });
export type CreateScheduledJobResponse = z.infer<typeof CreateScheduledJobResponse>;
export const createScheduledJobRoute = { method: 'POST', path: '/api/teams/:slug/scheduled-jobs' } as const;

export const ScheduledJobPathParams = z.object({ slug: TeamSlug, scheduledJobId: ScheduledJobId });
export type ScheduledJobPathParams = z.infer<typeof ScheduledJobPathParams>;

export const UpdateScheduledJobRequest = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  schedule: CronExpression.optional(),
  modelAlias: z.string().trim().min(1).max(40).nullable().optional(),
  effort: ScheduledJobEffort.nullable().optional(),
  contractPath: z.string().trim().min(1).max(300).nullable().optional(),
  outputPath: z.string().trim().min(1).max(300).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateScheduledJobRequest = z.infer<typeof UpdateScheduledJobRequest>;
export const UpdateScheduledJobResponse = z.object({ scheduledJob: ScheduledJob });
export type UpdateScheduledJobResponse = z.infer<typeof UpdateScheduledJobResponse>;
export const updateScheduledJobRoute = { method: 'PATCH', path: '/api/teams/:slug/scheduled-jobs/:scheduledJobId' } as const;

export const ListScheduledJobRunsResponse = z.object({ items: z.array(ScheduledJobRun) });
export type ListScheduledJobRunsResponse = z.infer<typeof ListScheduledJobRunsResponse>;
export const listScheduledJobRunsRoute = { method: 'GET', path: '/api/teams/:slug/scheduled-jobs/:scheduledJobId/runs' } as const;

/** Fire it now (the screen's "run now"): the same path a tick takes, with the same contract checks. */
export const RunScheduledJobResponse = z.object({ run: ScheduledJobRun });
export type RunScheduledJobResponse = z.infer<typeof RunScheduledJobResponse>;
export const runScheduledJobRoute = { method: 'POST', path: '/api/teams/:slug/scheduled-jobs/:scheduledJobId/run' } as const;
