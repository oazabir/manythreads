import { z } from 'zod';
import { MeetingId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// The meeting assistant in a live call (PLAN P17-06, docs/plans/meeting-assistant.md). A person in the call may ask a question about it (Ask) and, having come late, ask
// for a summary of what was said before they joined (Catch me up). With a note-taker in the room the note-taker answers (P15-24's path and rules); without one the
// workspace's Brain does, from the transcript so far and its own tools. Both are done by a job: the routes answer 202 at once and the result is pushed to the asker's
// own tabs (`meeting.ask`, `meeting.catchup`). An answer is also posted in the call's thread; a summary is shown to the person who asked only and is not kept.

/** Most characters of a question typed into the Ask panel. */
export const MEETING_ASK_QUESTION_MAX = 500;
/** A person who came at least this many minutes after the call started is offered Catch me up in the call bar. */
export const MEETING_CATCH_UP_OFFER_MINUTES = 2;

/** Who answers Ask in a room: the room's note-taker when there is one, else the workspace's Brain. */
export const MeetingAnswerer = z.object({ kind: z.enum(['brain', 'notetaker']), name: z.string().max(200) });
export type MeetingAnswerer = z.infer<typeof MeetingAnswerer>;

/** What the panel may offer the caller now. `reason` is one plain sentence when a part is not available (null when it is). */
export const MeetingAssistantStatus = z.object({
  ask: z.object({ available: z.boolean(), answerer: MeetingAnswerer.nullable(), reason: z.string().nullable() }),
  catchUp: z.object({
    available: z.boolean(),
    /** Whole minutes of the call before the caller joined (0 for someone who was there from the start). */
    minutesBefore: z.number().int().min(0),
    reason: z.string().nullable(),
  }),
});
export type MeetingAssistantStatus = z.infer<typeof MeetingAssistantStatus>;
export const getMeetingAssistantRoute = { method: 'GET', path: '/api/meetings/:meetingId/assistant' } as const satisfies ApiRoute;

export const MeetingAskRequest = z.strictObject({ question: z.string().trim().min(1).max(MEETING_ASK_QUESTION_MAX) });
export type MeetingAskRequest = z.infer<typeof MeetingAskRequest>;
export const MeetingAskResponse = z.object({ askId: z.uuid(), answerer: MeetingAnswerer });
export type MeetingAskResponse = z.infer<typeof MeetingAskResponse>;
export const meetingAskRoute = { method: 'POST', path: '/api/meetings/:meetingId/ask' } as const satisfies ApiRoute;

export const MeetingCatchUpResponse = z.object({ requestId: z.uuid(), minutesBefore: z.number().int().min(0) });
export type MeetingCatchUpResponse = z.infer<typeof MeetingCatchUpResponse>;
export const meetingCatchUpRoute = { method: 'POST', path: '/api/meetings/:meetingId/catch-up' } as const satisfies ApiRoute;

/**
 * Pushed to the asker's own tabs: `asking` when the question was taken (so every tab of theirs shows it waiting, whichever way it was asked), then `answered` (the answer,
 * also posted in the thread) or `failed` (one plain sentence). Every question taken gets one of the last two.
 */
export const MEETING_ASK_PUSH = 'meeting.ask';
export const MeetingAskPush = z.object({
  meetingId: MeetingId,
  askId: z.uuid(),
  state: z.enum(['asking', 'answered', 'failed']),
  answererName: z.string().max(200),
  text: z.string().max(4000),
  /** The question as it was taken (empty in a push of an older server). */
  question: z.string().max(MEETING_ASK_QUESTION_MAX).default(''),
});
export type MeetingAskPush = z.infer<typeof MeetingAskPush>;

/** Pushed to the person who asked for a summary: `ready` (the summary), `empty` (nothing was written down before they joined) or `failed` (why, in one sentence). */
export const MEETING_CATCHUP_PUSH = 'meeting.catchup';
export const MeetingCatchUpPush = z.object({
  meetingId: MeetingId,
  requestId: z.uuid(),
  state: z.enum(['ready', 'empty', 'failed']),
  minutesBefore: z.number().int().min(0),
  text: z.string().max(4000),
});
export type MeetingCatchUpPush = z.infer<typeof MeetingCatchUpPush>;
