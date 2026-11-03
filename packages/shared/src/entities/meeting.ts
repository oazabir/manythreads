import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, ChannelId, FileId, MeetingId, MessageId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

// Voice rooms (PLAN P15-01, plugin `meetings`). A meeting is one voice room opened from a channel (a DM call uses the DM's channel). Enums match the SQL CHECKs in
// plugins/meetings/migrations exactly (packages/kernel/test/schema-enums.test.ts compares both).

/** `live`: the room is open. `ended`: it is closed for good; a new call in the same channel is a new meeting. */
export const MeetingState = z.enum(['live', 'ended']);
export type MeetingState = z.infer<typeof MeetingState>;

/** Who closed the room: a person (the starter, a lead of the team or a workspace admin) or the platform after the last person left. */
export const MeetingEndReason = z.enum(['person', 'empty']);
export type MeetingEndReason = z.infer<typeof MeetingEndReason>;

/** Where the words come from: each person's own device, a server worker, or nowhere. `off` until someone turns transcription on (P15-05). */
export const MeetingTranscription = z.enum(['on_device', 'server', 'off']);
export type MeetingTranscription = z.infer<typeof MeetingTranscription>;

/** A person's answer to "may your voice be written down / recorded": `unasked` until they are asked. */
export const MeetingConsent = z.enum(['yes', 'no', 'unasked']);
export type MeetingConsent = z.infer<typeof MeetingConsent>;

/** Who wrote a transcript line: the speaker's own device or the server fallback. */
export const MeetingSegmentSource = z.enum(['device', 'server']);
export type MeetingSegmentSource = z.infer<typeof MeetingSegmentSource>;

/** A media token lives at most this long (seconds); the person asks for a new one while they may still read the channel (PLAN P15-02). */
export const MEDIA_TOKEN_MAX_SECONDS = 600;
/** A room with nobody in it closes itself this long after the last person left (seconds). */
export const MEETING_EMPTY_END_SECONDS = 120;
/** A person who has sent no sign of life (heartbeat) for this long is counted as having left (seconds). The room page sends one every 30 s. */
export const MEETING_PRESENCE_STALE_SECONDS = 180;
/** Most people in one room. */
export const MEETING_MAX_PARTICIPANTS = 50;
/** A room title is one line. */
export const MEETING_TITLE_MAX = 200;

export const MeetingTitle = z
  .string()
  .trim()
  .min(1, 'Write a title')
  .max(MEETING_TITLE_MAX, `A title can have at most ${MEETING_TITLE_MAX} characters`)
  .refine((t) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(t), { message: 'Write the title on one line' });
export type MeetingTitle = z.infer<typeof MeetingTitle>;

/** One voice room. A DM call has `teamId` null; a planned room without a channel (a team room) has `channelId` null. */
export const Meeting = z.object({
  id: MeetingId,
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  title: z.string().min(1).max(MEETING_TITLE_MAX),
  state: MeetingState,
  startedBy: ActorId,
  /** The starter, or the person who planned the meeting. Owns the notes and the transcript folder (later tasks). */
  organizerId: ActorId,
  /** The note-taker bot added to the room (P15-18); null until one is. */
  notetakerBotId: BotId.nullable(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  endReason: MeetingEndReason.nullable(),
  transcription: MeetingTranscription,
  recording: z.boolean(),
  /** Where the transcript was written (a repo path or a Files path); null until it is (P15-09). */
  transcriptPath: z.string().nullable(),
  transcriptFileId: FileId.nullable(),
  /** The root message of the call's chat thread, in the room's channel; null when the thread could not be made. */
  threadRootId: MessageId.nullable(),
});
export type Meeting = z.infer<typeof Meeting>;

/** One person in a room (or who was). The `actorId` is also the identity the media server knows the person by. */
export const MeetingParticipant = z.object({
  meetingId: MeetingId,
  actorId: ActorId,
  personId: PersonId,
  displayName: z.string(),
  joinedAt: IsoDateTime,
  /** Null while the person is in the room. */
  leftAt: IsoDateTime.nullable(),
  consentTranscribe: MeetingConsent,
  consentRecord: MeetingConsent,
});
export type MeetingParticipant = z.infer<typeof MeetingParticipant>;

/** One line of the transcript, written by the speaker's device (or the server fallback). Times are milliseconds from the meeting's start. */
export const MeetingSegment = z.object({
  meetingId: MeetingId,
  speakerId: ActorId,
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string().max(4000),
  final: z.boolean(),
  source: MeetingSegmentSource,
  lang: z.string().max(16).nullable(),
  createdAt: IsoDateTime,
});
export type MeetingSegment = z.infer<typeof MeetingSegment>;

/**
 * What a person needs to connect to the room: the media server's address, a short-lived token (`expiresAt` is at most ten minutes away) and the name the
 * server knows them by. The token is a credential: never log it, never store it.
 */
export const MeetingJoin = z.object({
  /** The media provider that made the token (`livekit`). */
  provider: z.string().min(1).max(40),
  url: z.string().min(1).max(2000),
  token: z.string().min(1).max(4000),
  /** The person's identity in the room: their actor id. */
  identity: ActorId,
  roomName: z.string().min(1).max(200),
  expiresAt: IsoDateTime,
});
export type MeetingJoin = z.infer<typeof MeetingJoin>;

/** A room as the list and the room page show it: the meeting and the people in it now. */
export const MeetingSummary = z.object({
  meeting: Meeting,
  /** Who is in the room right now (left_at null), oldest first. */
  present: z.array(MeetingParticipant),
});
export type MeetingSummary = z.infer<typeof MeetingSummary>;
