import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** Recording of a voice room's audio began (P15-15): everyone present had said yes. Ids only. */
export const MeetingsRecordingStartedEvent = z.object({
  type: z.literal('meetings.recording.started'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  startedBy: ActorId,
  /** How many people's audio is recorded (one file each). */
  people: z.number().int().min(1),
  at: IsoDateTime,
});
export type MeetingsRecordingStartedEvent = z.infer<typeof MeetingsRecordingStartedEvent>;
