import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, ScheduledMeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A planned room was cancelled (Bundle D, P16-05): by its organizer, because the event was deleted at the calendar, or because its channel was archived. */
export const MeetingsScheduledCancelledEvent = z.object({
  type: z.literal('meetings.scheduled.cancelled'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  scheduledMeetingId: ScheduledMeetingId,
  cancelledBy: ActorId.nullable(),
  reason: z.enum(['person', 'calendar_deleted', 'channel_archived']),
  at: IsoDateTime,
});
export type MeetingsScheduledCancelledEvent = z.infer<typeof MeetingsScheduledCancelledEvent>;
