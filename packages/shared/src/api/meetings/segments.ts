import { z } from 'zod';
import { MEETING_SEGMENT_BATCH_MAX, MeetingCaption, MeetingSegmentInput } from '../../entities/meeting.ts';
import { MeetingId, MeetingSegmentId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';
import { MeetingTranscriptLine } from './consent.ts';

// The lines of a voice room's transcript (PLAN P15-08, docs/plugins/meetings.md "Bundle C contracts"). A device sends the lines it heard from its own person's microphone;
// the server never takes a line for somebody else. A line is stored only while the speaker is in the room and has said yes to being transcribed (otherwise it is stored
// blank, as before); a partial line (`final: false`) only becomes a live caption. Words are hostile input: control and bidirectional characters are stripped.

export const MeetingSegmentPathParams = z.object({ meetingId: MeetingId, segId: MeetingSegmentId });
export type MeetingSegmentPathParams = z.infer<typeof MeetingSegmentPathParams>;

/** Up to `MEETING_SEGMENT_BATCH_MAX` lines at once; sending a `clientSegId` twice stores it once. */
export const PostMeetingSegmentsRequest = z.strictObject({ segments: z.array(MeetingSegmentInput).min(1).max(MEETING_SEGMENT_BATCH_MAX) });
export type PostMeetingSegmentsRequest = z.infer<typeof PostMeetingSegmentsRequest>;
export const PostMeetingSegmentsResponse = z.object({
  /** How many final lines were stored new. */
  stored: z.number().int().min(0),
  /** How many were already known (the same `clientSegId`) or dropped as a repeat of what the other device heard. */
  duplicates: z.number().int().min(0),
  /** How many partial lines were only shown as captions. */
  captioned: z.number().int().min(0),
  /** True when the speaker has not said yes: nothing of their words was kept (the lines were stored blank, or not at all). */
  blanked: z.boolean(),
});
export type PostMeetingSegmentsResponse = z.infer<typeof PostMeetingSegmentsResponse>;
export const postMeetingSegmentsRoute = { method: 'POST', path: '/api/meetings/:meetingId/segments' } as const satisfies ApiRoute;

/** A speaker corrects the words of their own line, for 24 hours. The transcript file is written again a little later. */
export const PatchMeetingSegmentRequest = z.strictObject({ text: z.string().min(1).max(4000) });
export type PatchMeetingSegmentRequest = z.infer<typeof PatchMeetingSegmentRequest>;
export const PatchMeetingSegmentResponse = z.object({ line: MeetingTranscriptLine });
export type PatchMeetingSegmentResponse = z.infer<typeof PatchMeetingSegmentResponse>;
export const patchMeetingSegmentRoute = { method: 'PATCH', path: '/api/meetings/:meetingId/segments/:segId' } as const satisfies ApiRoute;

// ---- Live pushes over the socket ---------------------------------------------------------------------------------------------------------------
/**
 * Pushed to the people present in a room (never to anyone else): the captions of the last quarter second, grouped. The server sends at most four of these a second per
 * room, so a busy room is one push per window, not one per line.
 */
export const MEETING_CAPTION_PUSH = 'meeting.caption';
export const MeetingCaptionPush = z.object({ meetingId: MeetingId, captions: z.array(MeetingCaption).min(1).max(50) });
export type MeetingCaptionPush = z.infer<typeof MeetingCaptionPush>;
