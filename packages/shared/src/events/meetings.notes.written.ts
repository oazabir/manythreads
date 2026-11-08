import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** The notes of a finished voice room were written (P15-10, P15-21): by which bot or person, and where. Never the text. */
export const MeetingsNotesWrittenEvent = z.object({
  type: z.literal('meetings.notes.written'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  writtenBy: ActorId,
  path: z.string().min(1).max(500),
  store: z.enum(['repo', 'files', 'organizer_files']),
  /** The people the action items were given to (exact name matches with a team member); the notifications plugin makes one row per owner. Ids only. */
  actionOwnerIds: z.array(ActorId).max(50).default([]),
  at: IsoDateTime,
});
export type MeetingsNotesWrittenEvent = z.infer<typeof MeetingsNotesWrittenEvent>;
