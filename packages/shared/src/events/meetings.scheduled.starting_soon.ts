import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, PersonId, ScheduledMeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A planned room starts in about five minutes (Bundle D, P16-05, decision D7). Sent once per plan by the reminder job; the notifications plugin makes one `meeting_soon` row per invited person. Ids only. */
export const MeetingsScheduledStartingSoonEvent = z.object({
  type: z.literal('meetings.scheduled.starting_soon'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  scheduledMeetingId: ScheduledMeetingId,
  /** The invited people of the workspace who can still read the channel. */
  attendeePersonIds: z.array(PersonId).max(50),
  startsAt: IsoDateTime,
  at: IsoDateTime,
});
export type MeetingsScheduledStartingSoonEvent = z.infer<typeof MeetingsScheduledStartingSoonEvent>;
