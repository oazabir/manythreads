import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** Recording of a voice room's audio stopped (P15-15), and why. Ids only. */
export const MeetingsRecordingStoppedEvent = z.object({
  type: z.literal('meetings.recording.stopped'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  reason: z.enum(['turned_off', 'left', 'ended', 'consent_withdrawn', 'joined_without_yes', 'failed']),
  /** Who turned it off; null when it stopped by itself. */
  stoppedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MeetingsRecordingStoppedEvent = z.infer<typeof MeetingsRecordingStoppedEvent>;
