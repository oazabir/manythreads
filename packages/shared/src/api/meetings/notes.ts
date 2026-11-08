import { z } from 'zod';
import { MEETING_NOTES_MAX_CHARS, MeetingNotes, MeetingOverview } from '../../entities/meeting.ts';
import { MeetingId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// A finished meeting's notes, summary and the buttons after it (PLAN P15-10 to P15-12, P15-20, P15-23). Access is decided by the server on every read: the organizer, a
// person the notes were shared with, or (for a team copy) whoever may read the channel. A person with no access gets 404, as if there were no such meeting.

/** The meeting view's header: title, date, length, people, links. */
export const GetMeetingOverviewResponse = MeetingOverview;
export type GetMeetingOverviewResponse = z.infer<typeof GetMeetingOverviewResponse>;
export const getMeetingOverviewRoute = { method: 'GET', path: '/api/meetings/:meetingId/summary' } as const satisfies ApiRoute;

/** `GET /api/meetings/by-path?path=...`: the meeting whose transcript or notes live at a Files path or a repo path (the Files screen's "Open the meeting"). */
export const GetMeetingByPathQuery = z.object({
  path: z.string().min(1).max(1024),
  /** Only for a repo path: the team's slug. */
  team: z.string().min(1).max(63).optional(),
});
export type GetMeetingByPathQuery = z.infer<typeof GetMeetingByPathQuery>;
export const GetMeetingByPathResponse = z.object({ meetingId: MeetingId });
export type GetMeetingByPathResponse = z.infer<typeof GetMeetingByPathResponse>;
export const getMeetingByPathRoute = { method: 'GET', path: '/api/meetings/by-path' } as const satisfies ApiRoute;

export const GetMeetingNotesResponse = MeetingNotes;
export type GetMeetingNotesResponse = z.infer<typeof GetMeetingNotesResponse>;
export const getMeetingNotesRoute = { method: 'GET', path: '/api/meetings/:meetingId/notes' } as const satisfies ApiRoute;

/** A person edits the notes file; the plugin writes it and the person is the author. `baseUpdatedAt` is the `updatedAt` they started from: a newer version is a 409. */
export const PutMeetingNotesRequest = z.strictObject({
  notesMd: z.string().max(MEETING_NOTES_MAX_CHARS),
  baseUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});
export type PutMeetingNotesRequest = z.infer<typeof PutMeetingNotesRequest>;
export const PutMeetingNotesResponse = MeetingNotes;
export type PutMeetingNotesResponse = z.infer<typeof PutMeetingNotesResponse>;
export const putMeetingNotesRoute = { method: 'PUT', path: '/api/meetings/:meetingId/notes' } as const satisfies ApiRoute;

/** A private or direct-message meeting is never filed to memory by itself: a participant sends it. The response carries the warning the dialog shows first (`confirmed: false`). */
export const SendMeetingToMemoryRequest = z.strictObject({ confirmed: z.boolean().default(false) });
export type SendMeetingToMemoryRequest = z.infer<typeof SendMeetingToMemoryRequest>;
export const SendMeetingToMemoryResponse = z.object({
  /** Always set: what filing does, in plain words, for the person to read before they confirm. */
  warning: z.string(),
  /** True once the notes and transcript were dropped into the team's memory inbox. */
  sent: z.boolean(),
  memoryItemId: z.string().nullable(),
});
export type SendMeetingToMemoryResponse = z.infer<typeof SendMeetingToMemoryResponse>;
export const sendMeetingToMemoryRoute = { method: 'POST', path: '/api/meetings/:meetingId/send-to-memory' } as const satisfies ApiRoute;

/** The organizer copies a note-taker meeting's notes and transcript to the team's meeting notes (once per meeting; a second try is a 409). */
export const SaveMeetingToTeamRequest = z.strictObject({
  /** The team to save to; defaults to the room's team. Needed for a direct-message call. */
  teamSlug: z.string().min(1).max(63).optional(),
  /** Also drop the notes into the team's memory inbox. On by default. */
  addToMemory: z.boolean().default(true),
});
export type SaveMeetingToTeamRequest = z.infer<typeof SaveMeetingToTeamRequest>;
export const SaveMeetingToTeamResponse = z.object({
  notes: MeetingNotes,
  /** Where the team copy is (a repo path). */
  path: z.string(),
  memoryItemId: z.string().nullable(),
});
export type SaveMeetingToTeamResponse = z.infer<typeof SaveMeetingToTeamResponse>;
export const saveMeetingToTeamRoute = { method: 'POST', path: '/api/meetings/:meetingId/save-to-team' } as const satisfies ApiRoute;

/** `GET /api/meetings/:meetingId/transcript?copy=organizer`: read the organizer's own copy (a shared reader's way in). Without it, the room's transcript. */
export const GetMeetingTranscriptQuery = z.object({ copy: z.enum(['organizer']).optional() });
export type GetMeetingTranscriptQuery = z.infer<typeof GetMeetingTranscriptQuery>;

/** The nudge in the thread after a note-taker meeting: carried in `meta.meetingNotes` of the bot's direct message so the web draws Share and Save buttons. */
export const MeetingNotesCardMeta = z.object({ meetingId: MeetingId });
export type MeetingNotesCardMeta = z.infer<typeof MeetingNotesCardMeta>;

// ---- Tools of the Scribe and the note-taker (capabilities `meetings.read`, `meetings.write_notes`) ----------------------------------------------------
/** `meetings.read`: the transcript of one meeting the run was started for, as the lines of speakers who said yes. */
export const MeetingsReadInput = z.strictObject({ meetingId: MeetingId });
export type MeetingsReadInput = z.infer<typeof MeetingsReadInput>;
