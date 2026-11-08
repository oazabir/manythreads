import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, ScheduledMeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A planned room changed (Bundle D, P16-05): by its organizer, or by the calendar sync copying a change made at the calendar (`changedBy` null). Says which parts changed, never their new text. */
export const MeetingsScheduledChangedEvent = z.object({
  type: z.literal('meetings.scheduled.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  scheduledMeetingId: ScheduledMeetingId,
  changedBy: ActorId.nullable(),
  fields: z.array(z.enum(['title', 'time', 'agenda', 'attendees'])).min(1).max(4),
  startsAt: IsoDateTime,
  at: IsoDateTime,
});
export type MeetingsScheduledChangedEvent = z.infer<typeof MeetingsScheduledChangedEvent>;
