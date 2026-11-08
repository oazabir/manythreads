import { z } from 'zod';
import { MeetingConsent, MeetingRecording, MeetingRecordingCap } from '../../entities/meeting.ts';
import type { ApiRoute } from '../client/route.ts';

// Recording a room's audio (PLAN P15-15). Off by default: the workspace switch (`recording_cap`) must be on, then anyone present may turn recording on for the room, and
// each person answers "Record my voice" separately. Audio is written as one file per consenting person, only while everyone present has said yes; it stops the moment
// someone who has not said yes joins. Files live in the channel's Files storage, never in git, and are deleted after `meetings.keepAudioDays` days (30 by default).

export const MeetingRecordingState = z.object({
  /** The workspace switch. */
  cap: MeetingRecordingCap,
  /** The room's setting: has someone turned recording on. */
  on: z.boolean(),
  /** True while audio is actually being written (on, and every person present said yes). */
  recording: z.boolean(),
  /** The caller's own answer to "Record my voice". */
  yourConsent: MeetingConsent,
  /** A plain sentence for a person when recording cannot be turned on (the workspace switch, the team's `TEAM.md`, no listener); null otherwise. */
  reason: z.string().nullable(),
  files: z.array(MeetingRecording),
});
export type MeetingRecordingState = z.infer<typeof MeetingRecordingState>;
export const getMeetingRecordingRoute = { method: 'GET', path: '/api/meetings/:meetingId/recording' } as const satisfies ApiRoute;

export const SetMeetingRecordingRequest = z.strictObject({ on: z.boolean() });
export type SetMeetingRecordingRequest = z.infer<typeof SetMeetingRecordingRequest>;
export const SetMeetingRecordingResponse = MeetingRecordingState;
export type SetMeetingRecordingResponse = z.infer<typeof SetMeetingRecordingResponse>;
export const setMeetingRecordingRoute = { method: 'PUT', path: '/api/meetings/:meetingId/recording' } as const satisfies ApiRoute;

/** The caller's own answer to "Record my voice". `no` also stops their file at once. */
export const MeetingRecordConsentRequest = z.strictObject({ record: MeetingConsent.exclude(['unasked']) });
export type MeetingRecordConsentRequest = z.infer<typeof MeetingRecordConsentRequest>;
export const MeetingRecordConsentResponse = MeetingRecordingState;
export type MeetingRecordConsentResponse = z.infer<typeof MeetingRecordConsentResponse>;
export const meetingRecordConsentRoute = { method: 'POST', path: '/api/meetings/:meetingId/record-consent' } as const satisfies ApiRoute;
