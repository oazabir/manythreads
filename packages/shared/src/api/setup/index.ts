import { z } from 'zod';
import { SetupSessionId } from '../../ids.ts';
import { SETUP_ANSWER_MAX, SETUP_BRIEF_MAX, SETUP_BRIEF_MIN, SETUP_MAX_QUESTIONS, SetupSession } from '../../entities/setup.ts';

// The routes of "Add a bot" (PLAN P7-04); the shapes are in entities/setup.ts. A session is the person's own: nobody else, a lead and an admin included, reads it.

export const TeamSetupParams = z.object({ slug: z.string().min(1) });
export type TeamSetupParams = z.infer<typeof TeamSetupParams>;
export const SetupSessionParams = z.object({ slug: z.string().min(1), sessionId: SetupSessionId });
export type SetupSessionParams = z.infer<typeof SetupSessionParams>;

/** Start with a brief. `name` is optional: the helper suggests one. */
export const CreateSetupSessionRequest = z.strictObject({
  brief: z.string().trim().min(SETUP_BRIEF_MIN, 'Write a sentence or two about what the bot should do.').max(SETUP_BRIEF_MAX),
  name: z.string().trim().min(1).max(80).optional(),
});
export type CreateSetupSessionRequest = z.infer<typeof CreateSetupSessionRequest>;

export const SetupSessionResponse = z.object({ session: SetupSession });
export type SetupSessionResponse = z.infer<typeof SetupSessionResponse>;
export const createSetupSessionRoute = { method: 'POST', path: '/api/teams/:slug/setup/sessions' } as const;
export const getSetupSessionRoute = { method: 'GET', path: '/api/teams/:slug/setup/sessions/:sessionId' } as const;

/** Answers to the open questions: one for each, in any order. The helper goes on once it has all of them. */
export const AnswerSetupRequest = z.strictObject({
  answers: z
    .array(z.strictObject({ questionId: z.string().regex(/^q[0-9]{1,3}$/), text: z.string().trim().min(1).max(SETUP_ANSWER_MAX) }))
    .min(1)
    .max(SETUP_MAX_QUESTIONS),
});
export type AnswerSetupRequest = z.infer<typeof AnswerSetupRequest>;
export const answerSetupRoute = { method: 'POST', path: '/api/teams/:slug/setup/sessions/:sessionId/answers' } as const;

export const CancelSetupRequest = z.strictObject({});
export type CancelSetupRequest = z.infer<typeof CancelSetupRequest>;
export const cancelSetupRoute = { method: 'POST', path: '/api/teams/:slug/setup/sessions/:sessionId/cancel' } as const;

/** Run the last round again after the session failed (the model was slow or busy). The answers already given are kept; nothing is asked again. */
export const RetrySetupRequest = z.strictObject({});
export type RetrySetupRequest = z.infer<typeof RetrySetupRequest>;
export const retrySetupRoute = { method: 'POST', path: '/api/teams/:slug/setup/sessions/:sessionId/retry' } as const;
