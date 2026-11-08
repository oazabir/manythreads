import { z } from 'zod';
import { MEETING_KEEP_AUDIO_DAYS_DEFAULT, MEETING_ROOM_CAP_MAX, MEETING_ROOM_CAP_MIN, MeetingConsent, MeetingParticipant, MeetingRecordingCap, MeetingState, MeetingTranscription } from '../../entities/meeting.ts';
import { ActorId, ChannelId, MeetingId, MeetingSegmentId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Consent and the transcription switch of a voice room (PLAN P15-05, docs/plugins/meetings.md). Anyone in the room may turn transcription on; everyone in the room
// then sees who did and answers "Transcribe my voice" yes or no. A person who answered no (or has not answered) appears in the transcript only as
// "<name> spoke (not transcribed)". What a room may turn on is capped by the workspace switch and by the team's `TEAM.md` (`meetings.transcribe`); the lower wins.

/** What `TEAM.md` may say about voice rooms, under `meetings` in the frontmatter. Every key may be left out; a missing `transcribe` means `on-device`. */
export const TeamMeetingsConfig = z.object({ transcribe: z.enum(['on-device', 'server', 'off']).default('on-device') });
export type TeamMeetingsConfig = z.infer<typeof TeamMeetingsConfig>;

/**
 * The other keys `TEAM.md` may carry under `meetings` (Bundle C), read apart from `transcribe` so that a typo here never switches transcription off. Every key may be left out.
 * `noteTaker: off` forbids adding a note-taker; `autoMemory: false` stops a public channel's meeting being filed into the team's memory by itself; `keepAudioDays` is how
 * long recorded audio is kept (1 to 3650 days).
 */
export const TeamMeetingsBundleConfig = z.object({
  noteTaker: z.enum(['on', 'off']).default('on'),
  autoMemory: z.boolean().default(true),
  keepAudioDays: z.number().int().min(1).max(3650).default(MEETING_KEEP_AUDIO_DAYS_DEFAULT),
});
export type TeamMeetingsBundleConfig = z.infer<typeof TeamMeetingsBundleConfig>;

/** The workspace switch: the most a voice room here may turn on. `off` forbids transcription; `on_device` allows each person's own device; `server` also allows the server fallback. */
export const MeetingsSettings = z.object({
  transcribeCap: MeetingTranscription,
  /** Most people in one room (2 to 100, 25 by default); a join over it is refused with a plain 409. */
  roomCap: z.number().int().min(MEETING_ROOM_CAP_MIN).max(MEETING_ROOM_CAP_MAX).default(25),
  /** Whether a room may record audio at all. Off until an admin turns it on. */
  recordingCap: MeetingRecordingCap.default('off'),
  /** Whether a team bot may be added to a room as its note-taker (it listens on the server). On by default. */
  notetakerAllowed: z.boolean().default(true),
});
export type MeetingsSettings = z.infer<typeof MeetingsSettings>;
/** Every field may be left out: only what is sent changes. */
export const MeetingsSettingsUpdate = z.strictObject({
  transcribeCap: MeetingTranscription.optional(),
  roomCap: z.number().int().min(MEETING_ROOM_CAP_MIN).max(MEETING_ROOM_CAP_MAX).optional(),
  recordingCap: MeetingRecordingCap.optional(),
  notetakerAllowed: z.boolean().optional(),
});
export type MeetingsSettingsUpdate = z.infer<typeof MeetingsSettingsUpdate>;
export const getMeetingsSettingsRoute = { method: 'GET', path: '/api/workspace/meetings-settings' } as const satisfies ApiRoute;
export const putMeetingsSettingsRoute = { method: 'PUT', path: '/api/workspace/meetings-settings' } as const satisfies ApiRoute;

/** The ways a room may turn transcription on, the device first. */
export const MeetingTranscribeMode = z.enum(['on_device', 'server']);
export type MeetingTranscribeMode = z.infer<typeof MeetingTranscribeMode>;

/** The room's transcription: whether it is on, who turned it on, and what it may be turned on as (the lower of the workspace switch and the team's `TEAM.md`). */
export const MeetingTranscriptionState = z.object({
  meetingId: MeetingId,
  mode: MeetingTranscription,
  /** Who turned it on; null while it is off. `displayName` is the name they joined with. */
  turnedOnBy: z.object({ actorId: ActorId, displayName: z.string() }).nullable(),
  /** What may be turned on now; empty when nothing may. */
  allowed: z.array(MeetingTranscribeMode),
  /** A plain sentence for a person when `allowed` is empty (who forbids it); null otherwise. */
  reason: z.string().nullable(),
});
export type MeetingTranscriptionState = z.infer<typeof MeetingTranscriptionState>;
export const getMeetingTranscriptionRoute = { method: 'GET', path: '/api/meetings/:meetingId/transcription' } as const satisfies ApiRoute;

/** Turn transcription on (`on_device` or `server`) or off. Only from `off` to a mode, or from a mode to `off`; changing the mode means turning it off first. */
export const SetMeetingTranscriptionRequest = z.strictObject({ mode: MeetingTranscription });
export type SetMeetingTranscriptionRequest = z.infer<typeof SetMeetingTranscriptionRequest>;
export const SetMeetingTranscriptionResponse = MeetingTranscriptionState;
export type SetMeetingTranscriptionResponse = z.infer<typeof SetMeetingTranscriptionResponse>;
export const setMeetingTranscriptionRoute = { method: 'PUT', path: '/api/meetings/:meetingId/transcription' } as const satisfies ApiRoute;

/** The caller's own answer to "Transcribe my voice". Answering no also blanks the words already stored for them. */
export const MeetingConsentRequest = z.strictObject({ transcribe: MeetingConsent.exclude(['unasked']) });
export type MeetingConsentRequest = z.infer<typeof MeetingConsentRequest>;
export const MeetingConsentResponse = z.object({ participant: MeetingParticipant });
export type MeetingConsentResponse = z.infer<typeof MeetingConsentResponse>;
export const meetingConsentRoute = { method: 'POST', path: '/api/meetings/:meetingId/consent' } as const satisfies ApiRoute;

/**
 * One line of the transcript as a reader may see it. A speaker who is not a "yes" shows as `<name> spoke (not transcribed)` with `transcribed: false` and the
 * times of the stretch they spoke; their words are never part of the answer.
 */
export const MeetingTranscriptLine = z.object({
  /** The stored line, for a correction; null for a stand-in line of someone who is not a "yes". */
  segmentId: MeetingSegmentId.nullable().default(null),
  speakerId: ActorId,
  speakerName: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string(),
  transcribed: z.boolean(),
  /** True when the caller may correct this line now (their own, within 24 hours). */
  editable: z.boolean().default(false),
});
export type MeetingTranscriptLine = z.infer<typeof MeetingTranscriptLine>;
export const GetMeetingTranscriptResponse = z.object({ lines: z.array(MeetingTranscriptLine) });
export type GetMeetingTranscriptResponse = z.infer<typeof GetMeetingTranscriptResponse>;
export const getMeetingTranscriptRoute = { method: 'GET', path: '/api/meetings/:meetingId/transcript' } as const satisfies ApiRoute;

// ---- Live pushes over the socket -------------------------------------------------------------------------------------------------------------------
/** Pushed to everyone who can read the room's channel when the room opens, closes, or someone comes or goes or changes the transcription: ask `GET /api/meetings/live` again. Ids only. */
export const MEETING_CHANGED_PUSH = 'meeting.changed';
/** Pushed to the other people of a direct message when one of them starts a call there: the page rings for `MEETING_RING_SECONDS`. Ids and the caller's name. */
export const MEETING_RINGING_PUSH = 'meeting.ringing';
/** How long an incoming direct-message call rings before it becomes a missed call. */
export const MEETING_RING_SECONDS = 30;
export const MeetingChangedPush = z.object({ meetingId: MeetingId, channelId: ChannelId.nullable(), state: MeetingState });
export type MeetingChangedPush = z.infer<typeof MeetingChangedPush>;
export const MeetingRingingPush = z.object({ meetingId: MeetingId, channelId: ChannelId, callerActorId: ActorId, callerName: z.string(), ringSeconds: z.number().int() });
export type MeetingRingingPush = z.infer<typeof MeetingRingingPush>;
