import { z } from 'zod';
import {
  RoutineClockTime,
  CronExpression,
  PersonalRoutine,
  PersonalRoutinePath,
  PersonalRoutineRun,
  RoutineOutputMode,
  RoutineSource,
  PERSONAL_ROUTINE_LIMITS,
  ROUTINE_SOURCES,
} from '../../entities/scheduled-job.ts';
import { ScheduledJobId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// P20-10 / P20-11 / P20-14: a person's own routines. Every route is "mine": it reads and writes the routines whose owner is the signed-in person, nothing else.
// A guest has no Personal space and so no routines (403). Nothing here ever enables a routine the person did not confirm: `draft` only proposes.

/** An IANA zone name such as `Asia/Dubai`. Checked again by the server against the zones it knows. */
export const TimeZoneName = z.string().trim().min(1).max(64).regex(/^[A-Za-z_]+(?:[/+-][A-Za-z0-9_+-]+)*$/, 'a time zone such as Asia/Dubai');

/** The hours in which a person's routines stay quiet: nothing is started between `from` and `to` in their time zone. A window may cross midnight (22:00 to 07:00). */
export const RoutineQuietHours = z.strictObject({ from: RoutineClockTime, to: RoutineClockTime }).refine((q) => q.from !== q.to, 'the quiet hours need two different times');
export type RoutineQuietHours = z.infer<typeof RoutineQuietHours>;

export const RoutineSettings = z.object({ timeZone: TimeZoneName.nullable(), quietHours: RoutineQuietHours.nullable() });
export type RoutineSettings = z.infer<typeof RoutineSettings>;

/** What a person is held to and has used. `spentUsd` is this calendar month (UTC) through the model gateway's ledger. */
export const RoutineLimits = z.object({
  maxRoutines: z.number().int(),
  used: z.number().int().min(0),
  minIntervalMinutes: z.number().int(),
  monthlyCapUsd: z.number().min(0),
  spentUsd: z.number().min(0),
  runToolCalls: z.number().int(),
});
export type RoutineLimits = z.infer<typeof RoutineLimits>;

export const ListPersonalRoutinesResponse = z.object({ items: z.array(PersonalRoutine), limits: RoutineLimits, settings: RoutineSettings });
export type ListPersonalRoutinesResponse = z.infer<typeof ListPersonalRoutinesResponse>;
export const listPersonalRoutinesRoute = { method: 'GET', path: '/api/me/scheduled-jobs' } as const satisfies ApiRoute;

const Prompt = z.string().trim().min(1).max(8000);
const Sources = z.array(RoutineSource).max(ROUTINE_SOURCES.length).refine((s) => new Set(s).size === s.length, 'each source once');
/** A routine's output goes into the owner's own files, never into `Memory/` (memory is written only through the memory tool). */
const OutputPath = PersonalRoutinePath.refine((p) => p.split('/')[0] !== 'Memory', 'Memory is written by the memory tool, not by a routine').refine(
  (p) => !/^Routines\/[^/]+\/routine\.yaml$/i.test(p),
  'A routine file is the routine itself; an output cannot be written over it',
);

/**
 * The confirmed routine. `confirmed: true` is the person's own yes to the proposal (`draft`); a request without it is refused, so a routine can never be
 * enabled by a script that skipped the preview. `botSlug` is a bot the person can talk to (Brain when left out).
 */
export const CreatePersonalRoutineRequest = z.strictObject({
  confirmed: z.literal(true),
  name: z.string().trim().min(1).max(80),
  words: z.string().trim().max(2000).default(''),
  botSlug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(64).default('brain'),
  schedule: CronExpression,
  scheduleWords: z.string().trim().min(1).max(120),
  timeZone: TimeZoneName,
  prompt: Prompt,
  sources: Sources.default([]),
  outputPath: OutputPath.optional(),
  outputMode: RoutineOutputMode.default('replace'),
  recipeId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
});
export type CreatePersonalRoutineRequest = z.infer<typeof CreatePersonalRoutineRequest>;
export const CreatePersonalRoutineResponse = z.object({ routine: PersonalRoutine });
export type CreatePersonalRoutineResponse = z.infer<typeof CreatePersonalRoutineResponse>;
export const createPersonalRoutineRoute = { method: 'POST', path: '/api/me/scheduled-jobs' } as const satisfies ApiRoute;

export const PersonalRoutinePathParams = z.object({ scheduledJobId: ScheduledJobId });
export type PersonalRoutinePathParams = z.infer<typeof PersonalRoutinePathParams>;

/** Change a routine. Turning it on again after the platform stopped it clears the stop. A change of schedule, words, sources or output is saved to the routine's file as a new version. */
export const UpdatePersonalRoutineRequest = z.strictObject({
  name: z.string().trim().min(1).max(80).optional(),
  words: z.string().trim().max(2000).optional(),
  schedule: CronExpression.optional(),
  scheduleWords: z.string().trim().min(1).max(120).optional(),
  timeZone: TimeZoneName.optional(),
  prompt: Prompt.optional(),
  sources: Sources.optional(),
  outputPath: OutputPath.optional(),
  outputMode: RoutineOutputMode.optional(),
  enabled: z.boolean().optional(),
});
export type UpdatePersonalRoutineRequest = z.infer<typeof UpdatePersonalRoutineRequest>;
export const UpdatePersonalRoutineResponse = z.object({ routine: PersonalRoutine });
export type UpdatePersonalRoutineResponse = z.infer<typeof UpdatePersonalRoutineResponse>;
export const updatePersonalRoutineRoute = { method: 'PATCH', path: '/api/me/scheduled-jobs/:scheduledJobId' } as const satisfies ApiRoute;

export const DeletePersonalRoutineResponse = z.object({ deleted: z.literal(true) });
export type DeletePersonalRoutineResponse = z.infer<typeof DeletePersonalRoutineResponse>;
export const deletePersonalRoutineRoute = { method: 'DELETE', path: '/api/me/scheduled-jobs/:scheduledJobId' } as const satisfies ApiRoute;

export const RunPersonalRoutineResponse = z.object({ run: PersonalRoutineRun });
export type RunPersonalRoutineResponse = z.infer<typeof RunPersonalRoutineResponse>;
export const runPersonalRoutineRoute = { method: 'POST', path: '/api/me/scheduled-jobs/:scheduledJobId/run' } as const satisfies ApiRoute;

export const ListPersonalRoutineRunsResponse = z.object({ items: z.array(PersonalRoutineRun) });
export type ListPersonalRoutineRunsResponse = z.infer<typeof ListPersonalRoutineRunsResponse>;
export const listPersonalRoutineRunsRoute = { method: 'GET', path: '/api/me/scheduled-jobs/:scheduledJobId/runs' } as const satisfies ApiRoute;

// ---- Setting up a routine in words (P20-11) ------------------------------------------------------------------------------------------------------

/** The sentence a person wrote and the time zone their screen is in. */
export const DraftPersonalRoutineRequest = z.strictObject({ sentence: z.string().trim().min(3).max(1000), timeZone: TimeZoneName });
export type DraftPersonalRoutineRequest = z.infer<typeof DraftPersonalRoutineRequest>;

/** What the assistant proposes. Nothing is saved: the person reads it, edits it and confirms (`createPersonalRoutineRoute`). */
export const PersonalRoutineDraft = z.object({
  name: z.string().min(1).max(80),
  schedule: CronExpression,
  scheduleWords: z.string().min(1).max(120),
  timeZone: TimeZoneName,
  prompt: Prompt,
  sources: Sources,
  outputPath: OutputPath,
  outputMode: RoutineOutputMode,
  botSlug: z.string(),
});
export type PersonalRoutineDraft = z.infer<typeof PersonalRoutineDraft>;

export const DraftPersonalRoutineResponse = z.object({
  draft: PersonalRoutineDraft,
  /** Plain sentences about what to check: a connection that is missing, a schedule that was rounded to the 15-minute floor. */
  notes: z.array(z.string().max(300)).max(8),
  /** `brain` when the assistant read the sentence; `rules` when the model was not available and plain rules did. */
  by: z.enum(['brain', 'rules']),
});
export type DraftPersonalRoutineResponse = z.infer<typeof DraftPersonalRoutineResponse>;
export const draftPersonalRoutineRoute = { method: 'POST', path: '/api/me/scheduled-jobs/draft' } as const satisfies ApiRoute;

// ---- Settings: time zone and quiet hours ----------------------------------------------------------------------------------------------------------

export const UpdateRoutineSettingsRequest = z.strictObject({ timeZone: TimeZoneName.nullable().optional(), quietHours: RoutineQuietHours.nullable().optional() });
export type UpdateRoutineSettingsRequest = z.infer<typeof UpdateRoutineSettingsRequest>;
export const UpdateRoutineSettingsResponse = z.object({ settings: RoutineSettings });
export type UpdateRoutineSettingsResponse = z.infer<typeof UpdateRoutineSettingsResponse>;
export const updateRoutineSettingsRoute = { method: 'PUT', path: '/api/me/routine-settings' } as const satisfies ApiRoute;

/** The workspace-wide spending allowance for each person's routines for one month, in US dollars. Admin only. */
export const RoutineWorkspaceSettings = z.object({ monthlyCapUsd: z.number().min(0).max(10_000) });
export type RoutineWorkspaceSettings = z.infer<typeof RoutineWorkspaceSettings>;
export const getRoutineWorkspaceSettingsRoute = { method: 'GET', path: '/api/workspace/routine-settings' } as const satisfies ApiRoute;
export const UpdateRoutineWorkspaceSettingsRequest = z.strictObject({ monthlyCapUsd: z.number().min(0).max(10_000) });
export type UpdateRoutineWorkspaceSettingsRequest = z.infer<typeof UpdateRoutineWorkspaceSettingsRequest>;
export const updateRoutineWorkspaceSettingsRoute = { method: 'PUT', path: '/api/workspace/routine-settings' } as const satisfies ApiRoute;

/** The defaults, for a screen that has not loaded the limits yet. */
export const ROUTINE_LIMIT_DEFAULTS: RoutineLimits = {
  maxRoutines: PERSONAL_ROUTINE_LIMITS.maxPerPerson,
  used: 0,
  minIntervalMinutes: PERSONAL_ROUTINE_LIMITS.minIntervalMinutes,
  monthlyCapUsd: PERSONAL_ROUTINE_LIMITS.monthlyCapUsdDefault,
  spentUsd: 0,
  runToolCalls: PERSONAL_ROUTINE_LIMITS.runToolCalls,
};
