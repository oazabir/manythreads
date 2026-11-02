import { z } from 'zod';
import { BotReassessmentId, RunId } from '../../ids.ts';
import { FullReplayEstimate, REPLAY_MAX_DAYS, Reassessment, ReassessmentAnswer, ReplayResult } from '../../entities/replay.ts';
import { WorkshopSession } from '../../entities/workshop.ts';

// The routes of replay and re-assessment (PLAN P7-07). Replay: a team lead or an admin sees every run of the bot they may read; anyone else only the runs they asked for themselves
// (a plain empty answer otherwise). Nothing here calls a model except the full replay, which needs the person to confirm its cost first.

export const ReplayBotParams = z.object({ slug: z.string().min(1), botSlug: z.string().min(1) });
export type ReplayBotParams = z.infer<typeof ReplayBotParams>;
export const ReplayRunParams = z.object({ slug: z.string().min(1), botSlug: z.string().min(1), runId: RunId });
export type ReplayRunParams = z.infer<typeof ReplayRunParams>;
export const ReassessmentParams = z.object({ slug: z.string().min(1), botSlug: z.string().min(1), reassessmentId: BotReassessmentId });
export type ReassessmentParams = z.infer<typeof ReassessmentParams>;

export const ReplayQuery = z.object({ days: z.coerce.number().int().min(1).max(REPLAY_MAX_DAYS).default(REPLAY_MAX_DAYS) });
export type ReplayQuery = z.infer<typeof ReplayQuery>;

export const ReplayResponse = z.object({ replay: ReplayResult });
export type ReplayResponse = z.infer<typeof ReplayResponse>;

/** Without `confirm` the answer is the estimate. With `confirm` carrying the estimate's `tokens` and `confirmToken` (the person has read it) the replay starts. Any other pair is refused. */
export const FullReplayRequest = z.strictObject({ confirm: z.strictObject({ tokens: z.number().int().min(0), token: z.string().min(1).max(64) }).optional() });
export type FullReplayRequest = z.infer<typeof FullReplayRequest>;

export const FullReplayResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('needs_confirmation'), estimate: FullReplayEstimate }),
  z.object({ status: z.literal('started'), estimate: FullReplayEstimate, session: WorkshopSession }),
]);
export type FullReplayResponse = z.infer<typeof FullReplayResponse>;

export const ReassessmentListResponse = z.object({ reassessments: z.array(Reassessment) });
export type ReassessmentListResponse = z.infer<typeof ReassessmentListResponse>;

export const CloseReassessmentRequest = z.strictObject({ answer: ReassessmentAnswer });
export type CloseReassessmentRequest = z.infer<typeof CloseReassessmentRequest>;
export const CloseReassessmentResponse = z.object({ reassessment: Reassessment });
export type CloseReassessmentResponse = z.infer<typeof CloseReassessmentResponse>;

export const replayBotRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/replay' } as const;
export const fullReplayRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/replay/runs/:runId/full' } as const;
export const listReassessmentsRoute = { method: 'GET', path: '/api/teams/:slug/bots/:botSlug/reassessments' } as const;
export const closeReassessmentRoute = { method: 'POST', path: '/api/teams/:slug/bots/:botSlug/reassessments/:reassessmentId/close' } as const;
