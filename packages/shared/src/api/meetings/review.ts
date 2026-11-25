import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, MeetingId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Mark action item and the end-of-call review (PLAN P17-06 step 2, docs/plans/meeting-assistant.md).
//
//  * MARK. A person in a live call presses "Mark action item": the server takes the final transcript lines of the last 30 seconds (only the words of people who said yes to
//    being transcribed) and keeps them as a mark of the call (`meeting_marks`, read by the readers of the call's channel).
//  * REVIEW. When the call has ended (and its notes are written, or did not come within ten minutes), the notes' action items and the marks open a review for the people who
//    were in the call: each item's words and owner can be changed, an item can be removed, and one person presses Confirm. Only the confirmed items go into the notes' list
//    of action items (and, later, into the follow-ups of P17-07). The people who were in the call get a notification that opens the meeting page, where the review is.

/** How far back a mark reaches: the lines that ended in the last 30 seconds. */
export const MEETING_MARK_WINDOW_MS = 30_000;
/** At most this many marks per person in one call. */
export const MEETING_MARKS_PER_PERSON = 30;
/** At most this many items in a review. */
export const MEETING_REVIEW_ITEMS_MAX = 50;
/** Most characters of one item's words. */
export const MEETING_REVIEW_TEXT_MAX = 1000;

/** One mark, as the person who pressed the button gets it back. `text` is the lines it took ("Nadia: I will send the draft."). */
export const MeetingMark = z.object({
  id: z.uuid(),
  meetingId: MeetingId,
  markedBy: ActorId,
  /** Where in the call (milliseconds from its start) the first line it took begins. */
  atMs: z.number().int().min(0),
  text: z.string().min(1).max(MEETING_REVIEW_TEXT_MAX),
  createdAt: IsoDateTime,
});
export type MeetingMark = z.infer<typeof MeetingMark>;
export const MarkMeetingActionResponse = z.object({
  mark: MeetingMark,
  /** How many marks the call has now (everyone's). */
  count: z.number().int().min(0),
});
export type MarkMeetingActionResponse = z.infer<typeof MarkMeetingActionResponse>;
export const markMeetingActionRoute = { method: 'POST', path: '/api/meetings/:meetingId/marks' } as const satisfies ApiRoute;

/** `open`: waiting for someone to confirm; `confirmed`: done (the notes carry the confirmed items). Matches the SQL CHECK. */
export const MeetingReviewStatus = z.enum(['open', 'confirmed']);
export type MeetingReviewStatus = z.infer<typeof MeetingReviewStatus>;
/** Where an item came from: the notes the Scribe wrote, or a mark pressed in the call. */
export const MeetingReviewItemSource = z.enum(['notes', 'mark']);
export type MeetingReviewItemSource = z.infer<typeof MeetingReviewItemSource>;

/** One action item in a review. `ownerId` is a person's actor id (null: no owner); `ownerName` is the name shown. */
export const MeetingReviewItem = z.object({
  id: z.uuid(),
  source: MeetingReviewItemSource,
  text: z.string().min(1).max(MEETING_REVIEW_TEXT_MAX),
  ownerId: ActorId.nullable(),
  ownerName: z.string().max(200).nullable(),
  /** A day, `YYYY-MM-DD`, when the notes found one. */
  due: z.iso.date().nullable(),
  atMs: z.number().int().min(0),
});
export type MeetingReviewItem = z.infer<typeof MeetingReviewItem>;

/** Someone who may be given an item: a person who was in the call, or a team member the notes named. */
export const MeetingReviewPerson = z.object({ actorId: ActorId, displayName: z.string().max(200) });
export type MeetingReviewPerson = z.infer<typeof MeetingReviewPerson>;

/** A call's review as one of the people who were in it reads it. */
export const MeetingReview = z.object({
  meetingId: MeetingId,
  status: MeetingReviewStatus,
  /** The items to confirm (status `open`), or the items that were confirmed (status `confirmed`). */
  items: z.array(MeetingReviewItem).max(MEETING_REVIEW_ITEMS_MAX),
  /** True once the notes' action items are part of the review (false: the notes were not written, or are the organizer's own copy). */
  notesIncluded: z.boolean(),
  openedAt: IsoDateTime,
  confirmedAt: IsoDateTime.nullable(),
  confirmedByName: z.string().max(200).nullable(),
  /** Whether the caller may press Confirm now (a person who was in the call, while the review is open). */
  canConfirm: z.boolean(),
  /** Who an item can be given to. */
  people: z.array(MeetingReviewPerson).max(250),
});
export type MeetingReview = z.infer<typeof MeetingReview>;

/** `review` is null while there is none for the caller: the call is still live, nothing was marked or found, or the caller was not in the call. */
export const GetMeetingReviewResponse = z.object({ review: MeetingReview.nullable() });
export type GetMeetingReviewResponse = z.infer<typeof GetMeetingReviewResponse>;
export const getMeetingReviewRoute = { method: 'GET', path: '/api/meetings/:meetingId/review' } as const satisfies ApiRoute;

/**
 * Confirm the review: the items kept, each with its (edited) words and owner, in order. An item left out is removed. Only items of the review can be sent (by `id`); the
 * server fills in the owner's name and keeps the day and the time of each. `count` is how many the person saw on the button, so a review that changed under them is a 409.
 */
export const ConfirmMeetingReviewRequest = z.strictObject({
  items: z
    .array(z.strictObject({ id: z.uuid(), text: z.string().trim().min(1).max(MEETING_REVIEW_TEXT_MAX), ownerId: ActorId.nullable() }))
    .max(MEETING_REVIEW_ITEMS_MAX),
  /** How many items the review had when the person opened it. */
  seen: z.number().int().min(0).max(MEETING_REVIEW_ITEMS_MAX),
});
export type ConfirmMeetingReviewRequest = z.infer<typeof ConfirmMeetingReviewRequest>;
export const ConfirmMeetingReviewResponse = z.object({ review: MeetingReview });
export type ConfirmMeetingReviewResponse = z.infer<typeof ConfirmMeetingReviewResponse>;
export const confirmMeetingReviewRoute = { method: 'POST', path: '/api/meetings/:meetingId/review/confirm' } as const satisfies ApiRoute;

/** Pushed to the people who were in the call when their review opens, changes or is confirmed: ids only; the page asks again. */
export const MEETING_REVIEW_PUSH = 'meeting.review';
export const MeetingReviewPush = z.object({ meetingId: MeetingId, status: MeetingReviewStatus });
export type MeetingReviewPush = z.infer<typeof MeetingReviewPush>;
