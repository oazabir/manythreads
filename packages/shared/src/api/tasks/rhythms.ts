import { z } from 'zod';
import { CronExpression, Rhythm, RhythmEffort, RhythmKind, RhythmRun } from '../../entities/rhythm.ts';
import { BotId, RhythmId } from '../../ids.ts';
import { TeamSlug } from '../teams/common.ts';

export const ListRhythmsPathParams = z.object({ slug: TeamSlug });
export type ListRhythmsPathParams = z.infer<typeof ListRhythmsPathParams>;

export const ListRhythmsResponse = z.object({ items: z.array(Rhythm) });
export type ListRhythmsResponse = z.infer<typeof ListRhythmsResponse>;
export const listRhythmsRoute = { method: 'GET', path: '/api/teams/:slug/rhythms' } as const;

/** One of `botId` / `botSlug` names the bot. A routine needs a contract path; a heartbeat and a task do not. */
export const CreateRhythmRequest = z
  .strictObject({
    botId: BotId.optional(),
    botSlug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
    name: z.string().trim().min(1).max(80),
    kind: RhythmKind,
    schedule: CronExpression,
    modelAlias: z.string().trim().min(1).max(40).nullable().default(null),
    effort: RhythmEffort.nullable().default(null),
    contractPath: z.string().trim().min(1).max(300).nullable().default(null),
    outputPath: z.string().trim().min(1).max(300).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .refine((v) => (v.botId === undefined) !== (v.botSlug === undefined), 'name exactly one bot: botId or botSlug')
  .refine((v) => v.kind !== 'routine' || v.contractPath !== null, 'a routine needs a contract path');
export type CreateRhythmRequest = z.infer<typeof CreateRhythmRequest>;
export const CreateRhythmResponse = z.object({ rhythm: Rhythm });
export type CreateRhythmResponse = z.infer<typeof CreateRhythmResponse>;
export const createRhythmRoute = { method: 'POST', path: '/api/teams/:slug/rhythms' } as const;

export const RhythmPathParams = z.object({ slug: TeamSlug, rhythmId: RhythmId });
export type RhythmPathParams = z.infer<typeof RhythmPathParams>;

export const UpdateRhythmRequest = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  schedule: CronExpression.optional(),
  modelAlias: z.string().trim().min(1).max(40).nullable().optional(),
  effort: RhythmEffort.nullable().optional(),
  contractPath: z.string().trim().min(1).max(300).nullable().optional(),
  outputPath: z.string().trim().min(1).max(300).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateRhythmRequest = z.infer<typeof UpdateRhythmRequest>;
export const UpdateRhythmResponse = z.object({ rhythm: Rhythm });
export type UpdateRhythmResponse = z.infer<typeof UpdateRhythmResponse>;
export const updateRhythmRoute = { method: 'PATCH', path: '/api/teams/:slug/rhythms/:rhythmId' } as const;

export const ListRhythmRunsResponse = z.object({ items: z.array(RhythmRun) });
export type ListRhythmRunsResponse = z.infer<typeof ListRhythmRunsResponse>;
export const listRhythmRunsRoute = { method: 'GET', path: '/api/teams/:slug/rhythms/:rhythmId/runs' } as const;

/** Fire it now (the screen's "run now"): the same path a tick takes, with the same contract checks. */
export const RunRhythmResponse = z.object({ run: RhythmRun });
export type RunRhythmResponse = z.infer<typeof RunRhythmResponse>;
export const runRhythmRoute = { method: 'POST', path: '/api/teams/:slug/rhythms/:rhythmId/run' } as const;
