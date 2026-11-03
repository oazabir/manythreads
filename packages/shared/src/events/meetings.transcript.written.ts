import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** The transcript of a finished voice room was written (P15-09): where (a repo path or a Files path) and how many lines. Never the text. */
export const MeetingsTranscriptWrittenEvent = z.object({
  type: z.literal('meetings.transcript.written'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  path: z.string().min(1).max(500),
  store: z.enum(['repo', 'files', 'organizer_files']),
  lineCount: z.number().int().min(0),
  at: IsoDateTime,
});
export type MeetingsTranscriptWrittenEvent = z.infer<typeof MeetingsTranscriptWrittenEvent>;
