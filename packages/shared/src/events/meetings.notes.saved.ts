import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** The organizer saved a note-taker meeting's notes and transcript to the team's meeting notes (P15-23). Paths and ids only, never the text. */
export const MeetingsNotesSavedEvent = z.object({
  type: z.literal('meetings.notes.saved'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  savedBy: ActorId,
  path: z.string().min(1).max(500),
  /** True when the notes were also dropped into the team's memory inbox. */
  toMemory: z.boolean(),
  at: IsoDateTime,
});
export type MeetingsNotesSavedEvent = z.infer<typeof MeetingsNotesSavedEvent>;
