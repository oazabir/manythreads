import { z } from 'zod';
import { MeetingId, ChannelId, TeamId } from '../../ids.ts';

// Searching what was said in meetings (PLAN P15-13). The `meetings.search` capability gives a bot the same answer a person's search gets: the lines of meetings the asker
// may read, and no others. A line counts only if its speaker said yes to being transcribed.

export const MEETINGS_SEARCH_CAPABILITY = 'meetings.search';
export const MEETINGS_READ_CAPABILITY = 'meetings.read';
export const MEETINGS_NOTES_WRITE_CAPABILITY = 'meetings.write_notes';

export const MeetingsSearchInput = z.strictObject({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(8),
});
export type MeetingsSearchInput = z.infer<typeof MeetingsSearchInput>;

export const MeetingsSearchHit = z.object({
  meetingId: MeetingId,
  title: z.string(),
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  /** Whole-meeting hit (the notes) has `atMs` 0. */
  atMs: z.number().int().min(0),
  speakerName: z.string().nullable(),
  snippet: z.string().max(300),
  /** `notes` when the hit is in the notes, `transcript` when in a line. */
  where: z.enum(['notes', 'transcript']),
  startedAt: z.string(),
});
export type MeetingsSearchHit = z.infer<typeof MeetingsSearchHit>;
export const MeetingsSearchOutput = z.object({ hits: z.array(MeetingsSearchHit) });
export type MeetingsSearchOutput = z.infer<typeof MeetingsSearchOutput>;
