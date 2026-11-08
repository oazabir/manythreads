import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, ChannelId, FileId, MeetingId, MeetingRecordingId, MeetingShareId, MessageId, PersonId, TeamId, WorkspaceId } from '../ids.ts';
import { Avatar } from './avatar.ts';

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

// ---- Bundle C: transcripts, notes, the note-taker, sharing and recording (PLAN P15-08 to P15-24, docs/plugins/meetings.md "Bundle C contracts") -----------------------

/** The most a room may hold by default, and the bounds an admin may set (`meeting_settings.room_cap`). */
export const MEETING_ROOM_CAP_DEFAULT = 25;
export const MEETING_ROOM_CAP_MIN = 2;
export const MEETING_ROOM_CAP_MAX = 100;
/** Most characters of one transcript line (also the SQL CHECK of `meeting_segments.text`). */
export const MEETING_SEGMENT_TEXT_MAX = 4000;
/** Most lines one `POST /api/meetings/:id/segments` carries. */
export const MEETING_SEGMENT_BATCH_MAX = 20;
/** Lines are still taken this long after a room ended (seconds); the insert trigger enforces it, whoever inserts. */
export const MEETING_LATE_LINE_SECONDS = 120;
/** The transcript job runs this long after the room ended: the late window plus ten seconds (seconds). */
export const MEETING_TRANSCRIPT_DELAY_SECONDS = 130;
/** A speaker may correct their own line for this long after it was stored (hours); the SQL function enforces it. */
export const MEETING_CORRECTION_HOURS = 24;
/** A correction re-writes the transcript file after this quiet time (seconds). */
export const MEETING_CORRECTION_DEBOUNCE_SECONDS = 30;
/** The longest notes text, in characters (also the SQL CHECK of `meeting_notes.notes_md`). */
export const MEETING_NOTES_MAX_CHARS = 200_000;
/** A transcript file is cut at this size (bytes) with a final "transcript truncated" line. */
export const MEETING_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
/** Per-person limit on `POST …/segments` a minute, and the cap of lines one room takes a minute. */
export const MEETING_SEGMENTS_PER_MINUTE = 240;
export const MEETING_ROOM_LINES_PER_MINUTE = 1000;
/** Live captions are coalesced per room: at most this many pushes a second, one window of this many milliseconds. */
export const MEETING_CAPTION_PUSHES_PER_SECOND = 4;
export const MEETING_CAPTION_WINDOW_MS = 250;
/** One uploaded audio chunk (server fallback): at most this many bytes and this long; at most this many uploads a minute per person. */
export const MEETING_AUDIO_CHUNK_MAX_BYTES = 2 * 1024 * 1024;
export const MEETING_AUDIO_CHUNK_MAX_MS = 30_000;
export const MEETING_AUDIO_CHUNKS_PER_MINUTE = 120;
/** Rooms with a note-taker one server process listens to at once (`MANYTHREADS_NOTETAKER_MAX_ROOMS`), and questions to it a minute per room. */
export const MEETING_NOTETAKER_MAX_ROOMS_DEFAULT = 10;
export const MEETING_QUESTIONS_PER_MINUTE = 6;
/** Recorded audio is kept this many days unless `TEAM.md` `meetings.keepAudioDays` says otherwise. */
export const MEETING_KEEP_AUDIO_DAYS_DEFAULT = 30;

/**
 * What the workspace switch lets a room record: `off` (the default) forbids recording, `on` allows it where every person present agrees. Matches the CHECK of
 * `meeting_settings.recording_cap`.
 */
export const MeetingRecordingCap = z.enum(['off', 'on']);
export type MeetingRecordingCap = z.infer<typeof MeetingRecordingCap>;

/** Where a meeting's transcript and notes live: the team repo (a public channel), the channel's Files folder (a private channel or a DM), or the organizer's Personal space (a note-taker meeting). */
export const MeetingNotesLocation = z.enum(['repo', 'channel_files', 'personal']);
export type MeetingNotesLocation = z.infer<typeof MeetingNotesLocation>;

/** `pending`: the transcript is written and the notes are not yet; `written`: the notes exist; `failed`: the notes could not be made (the transcript is still there). */
export const MeetingNotesStatus = z.enum(['pending', 'written', 'failed']);
export type MeetingNotesStatus = z.infer<typeof MeetingNotesStatus>;

/** Who a share is for: one person, or everyone who can read a channel. */
export const MeetingShareGranteeKind = z.enum(['person', 'channel']);
export type MeetingShareGranteeKind = z.infer<typeof MeetingShareGranteeKind>;

/** Why a person's recording stopped. */
export const MeetingRecordingStopReason = z.enum(['turned_off', 'left', 'ended', 'consent_withdrawn', 'joined_without_yes', 'failed']);
export type MeetingRecordingStopReason = z.infer<typeof MeetingRecordingStopReason>;

/** What kind of note an item is. */
export const MeetingNoteItemKind = z.enum(['decision', 'action', 'question']);
export type MeetingNoteItemKind = z.infer<typeof MeetingNoteItemKind>;

/** A clean one-line client id for a line, so sending it twice stores it once. */
export const MeetingClientSegId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'letters, digits, ".", "_", ":" or "-"');
export type MeetingClientSegId = z.infer<typeof MeetingClientSegId>;

/**
 * One line a device sends (`POST /api/meetings/:id/segments`). `startMs`/`endMs` are milliseconds on the meeting clock (since `meetings.started_at`). A `final` line is
 * stored; a partial one (`final: false`) only becomes a live caption and is never stored. Words are hostile input: the server strips control and bidirectional characters.
 */
export const MeetingSegmentInput = z
  .strictObject({
    clientSegId: MeetingClientSegId,
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    text: z.string().max(MEETING_SEGMENT_TEXT_MAX),
    final: z.boolean(),
    lang: z.string().min(2).max(16).nullable().optional(),
  })
  .refine((s) => s.endMs >= s.startMs, { message: 'A line cannot end before it starts', path: ['endMs'] });
export type MeetingSegmentInput = z.infer<typeof MeetingSegmentInput>;

/** One live caption: a stretch of someone's speech as the people in the room see it while it is said. A `kind: answer` caption is the note-taker's answer and names the asker. */
export const MeetingCaptionKind = z.enum(['speech', 'answer']);
export type MeetingCaptionKind = z.infer<typeof MeetingCaptionKind>;
export const MeetingCaption = z.object({
  kind: MeetingCaptionKind,
  speakerId: ActorId,
  speakerName: z.string().max(200),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string().max(MEETING_SEGMENT_TEXT_MAX),
  /** False while the words may still change (a partial); true when the line is final. */
  final: z.boolean(),
  /** True while the server transcriber is more than a minute behind: the line is real, only late. */
  catchingUp: z.boolean().default(false),
  /** For `kind: answer`: who asked. */
  askerName: z.string().max(200).nullable().default(null),
});
export type MeetingCaption = z.infer<typeof MeetingCaption>;

/** One thing the notes found. `atMs` is the transcript line it comes from (the notes drop any item whose time is not a line). `ownerId` is set only for an exact name match with a team member. */
export const MeetingNoteItem = z.object({
  kind: MeetingNoteItemKind,
  text: z.string().min(1).max(1000),
  ownerName: z.string().max(200).nullable(),
  ownerId: ActorId.nullable(),
  /** A day, `YYYY-MM-DD`; null when none was said. */
  due: z.iso.date().nullable(),
  atMs: z.number().int().min(0),
});
export type MeetingNoteItem = z.infer<typeof MeetingNoteItem>;

/** What the Scribe or the note-taker answers (JSON from the model), before the platform checks it and writes `notes.md`. */
export const MeetingNotesDraft = z.object({
  summary: z.string().max(4000),
  decisions: z.array(z.object({ text: z.string().min(1).max(1000), atMs: z.number().int().min(0) })).max(50),
  actionItems: z.array(z.object({ text: z.string().min(1).max(1000), owner: z.string().max(200).nullable(), due: z.iso.date().nullable(), atMs: z.number().int().min(0) })).max(50),
  questions: z.array(z.object({ text: z.string().min(1).max(1000), atMs: z.number().int().min(0) })).max(50),
});
export type MeetingNotesDraft = z.infer<typeof MeetingNotesDraft>;

/** A meeting's notes as a reader gets them (`GET /api/meetings/:id/notes`). The `can*` flags say which buttons the page may draw. */
export const MeetingNotes = z.object({
  meetingId: MeetingId,
  status: MeetingNotesStatus,
  location: MeetingNotesLocation,
  /** The short summary; empty until the notes are written. */
  summary: z.string(),
  items: z.array(MeetingNoteItem),
  /** The notes file as markdown. */
  notesMd: z.string().max(MEETING_NOTES_MAX_CHARS),
  /** Where the files are: a repo path, or a Files path. Null for a Personal copy another person reads through a share. */
  transcriptPath: z.string().nullable(),
  notesPath: z.string().nullable(),
  /** A plain sentence when `status` is `failed`. */
  failure: z.string().nullable(),
  /** The memory inbox item the notes were filed as; null when nothing was filed. */
  memoryItemId: z.string().nullable(),
  /** Where "Save to team" copied the notes in the team repo; null until saved. */
  savedPath: z.string().nullable(),
  savedAt: IsoDateTime.nullable(),
  savedBy: ActorId.nullable(),
  updatedAt: IsoDateTime,
  canEdit: z.boolean(),
  canShare: z.boolean(),
  canSaveToTeam: z.boolean(),
  canSendToMemory: z.boolean(),
});
export type MeetingNotes = z.infer<typeof MeetingNotes>;

/** A bot that may be added to a room as its note-taker. */
export const MeetingNotetakerBot = z.object({
  botId: BotId,
  slug: z.string(),
  name: z.string(),
  role: z.string(),
  avatar: Avatar.nullable().default(null),
});
export type MeetingNotetakerBot = z.infer<typeof MeetingNotetakerBot>;

/** The note-taker in a room: the bot, and whether it is listening now. */
export const MeetingNotetaker = z.object({
  bot: MeetingNotetakerBot,
  listening: z.boolean(),
});
export type MeetingNotetaker = z.infer<typeof MeetingNotetaker>;

/** Access to a meeting's notes the organizer gave. */
export const MeetingShareGrantee = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), personId: PersonId, displayName: z.string() }),
  z.object({ kind: z.literal('channel'), channelId: ChannelId, channelName: z.string().nullable() }),
]);
export type MeetingShareGrantee = z.infer<typeof MeetingShareGrantee>;
export const MeetingShare = z.object({
  id: MeetingShareId,
  meetingId: MeetingId,
  grantee: MeetingShareGrantee,
  createdBy: ActorId,
  createdAt: IsoDateTime,
  revokedAt: IsoDateTime.nullable(),
});
export type MeetingShare = z.infer<typeof MeetingShare>;

/** One person's recorded audio of a room (only people who said yes to being recorded). */
export const MeetingRecording = z.object({
  id: MeetingRecordingId,
  meetingId: MeetingId,
  actorId: ActorId,
  fileId: FileId.nullable(),
  startedAt: IsoDateTime,
  stoppedAt: IsoDateTime.nullable(),
  stopReason: MeetingRecordingStopReason.nullable(),
});
export type MeetingRecording = z.infer<typeof MeetingRecording>;

/** What the meeting view (`/meetings/:meetingId`) shows at the top. */
export const MeetingOverview = z.object({
  meeting: Meeting,
  teamSlug: z.string().nullable(),
  channelName: z.string().nullable(),
  /** Whole seconds from start to end; null while the room is live. */
  durationSeconds: z.number().int().min(0).nullable(),
  organizerName: z.string(),
  /** Everyone who was in the room at any time, by the name they joined with. */
  people: z.array(z.object({ actorId: ActorId, displayName: z.string(), transcribed: z.boolean() })),
  /** Where things are; null while there is nothing yet. */
  location: MeetingNotesLocation.nullable(),
  transcriptPath: z.string().nullable(),
  notesPath: z.string().nullable(),
  notesStatus: MeetingNotesStatus.nullable(),
  /** The call's chat thread. */
  thread: z.object({ channelId: ChannelId, rootId: MessageId }).nullable(),
  /** True when audio was recorded and is still kept. */
  hasAudio: z.boolean(),
  notetaker: MeetingNotetakerBot.nullable(),
  /** Counts for the headings: `Decisions 2`, `Action items 3`. */
  decisionCount: z.number().int().min(0),
  actionItemCount: z.number().int().min(0),
  you: z.object({ isOrganizer: z.boolean(), canManage: z.boolean(), canReadNotes: z.boolean() }),
});
export type MeetingOverview = z.infer<typeof MeetingOverview>;
