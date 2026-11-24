import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, MeetingId, MeetingShareRequestId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// "Ask to share" (PLAN P17-02). One screen is shared in a call at a time (P35-08). While someone shares, another person in the call may ask them for a turn: the
// request goes through the server, which checks that both are in the live call, keeps one request per asker, and tells only the person asked. The person sharing
// answers "Stop and let them share" or "Not now", or lets the request lapse after `MEETING_SHARE_ASK_SECONDS`. Saying yes stops their own share; the asker is told
// they may share now and presses Share themself (a browser shares a screen only after a press on the page).

/** How long a request to share waits for an answer. */
export const MEETING_SHARE_ASK_SECONDS = 60;

export const MeetingShareRequestPathParams = z.object({ meetingId: MeetingId, requestId: MeetingShareRequestId });
export type MeetingShareRequestPathParams = z.infer<typeof MeetingShareRequestPathParams>;

/** Ask the person sharing a screen now (`sharerActorId`, as the asker's page sees it) for a turn. */
export const AskToShareRequest = z.strictObject({ sharerActorId: ActorId });
export type AskToShareRequest = z.infer<typeof AskToShareRequest>;
export const AskToShareResponse = z.object({ requestId: MeetingShareRequestId, expiresAt: IsoDateTime });
export type AskToShareResponse = z.infer<typeof AskToShareResponse>;
export const askToShareRoute = { method: 'POST', path: '/api/meetings/:meetingId/share-requests' } as const satisfies ApiRoute;

/** A request's state in `app.meeting_share_requests.state` (migration 0011): waiting, said yes, or said no (also when someone else was let share first). */
export const MeetingShareRequestState = z.enum(['pending', 'accepted', 'declined']);
export type MeetingShareRequestState = z.infer<typeof MeetingShareRequestState>;

/** What the person asked says: `accept` or `decline` ("Not now"). */
export const ShareRequestAnswer = z.enum(['accept', 'decline']);
export type ShareRequestAnswer = z.infer<typeof ShareRequestAnswer>;
/**
 * What the asker is told: `accept`, `decline`, or `other` (the person asked said yes to someone else's request, so this one was turned down on the server).
 */
export const ShareRequestOutcome = z.enum(['accept', 'decline', 'other']);
export type ShareRequestOutcome = z.infer<typeof ShareRequestOutcome>;
/** The person asked answers. Saying yes also turns down every other request waiting for them (`other`), so only one asker is let share. */
export const AnswerShareRequest = z.strictObject({ answer: ShareRequestAnswer });
export type AnswerShareRequest = z.infer<typeof AnswerShareRequest>;
export const AnswerShareResponse = z.object({ answer: ShareRequestAnswer });
export type AnswerShareResponse = z.infer<typeof AnswerShareResponse>;
export const answerShareRoute = { method: 'POST', path: '/api/meetings/:meetingId/share-requests/:requestId/answer' } as const satisfies ApiRoute;

// ---- pushes over the socket ------------------------------------------------------------------------------------------------------------------------
/** Pushed to the person sharing a screen (only them) when someone in the call asks for a turn. The asker's name as the call knows it. */
export const MEETING_SHARE_ASKED_PUSH = 'meeting.share_asked';
export const MeetingShareAskedPush = z.object({ meetingId: MeetingId, requestId: MeetingShareRequestId, askerActorId: ActorId, askerName: z.string(), expiresAt: IsoDateTime });
export type MeetingShareAskedPush = z.infer<typeof MeetingShareAskedPush>;
/** Pushed to the asker (only them) when the person sharing answered. */
export const MEETING_SHARE_ANSWERED_PUSH = 'meeting.share_answered';
export const MeetingShareAnsweredPush = z.object({ meetingId: MeetingId, requestId: MeetingShareRequestId, sharerActorId: ActorId, answer: ShareRequestOutcome });
export type MeetingShareAnsweredPush = z.infer<typeof MeetingShareAnsweredPush>;
