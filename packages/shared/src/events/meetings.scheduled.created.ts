import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ScheduledMeetingProvider } from '../entities/scheduled-meeting.ts';
import { ActorId, ChannelId, ScheduledMeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A voice room was planned ahead (Bundle D, P16-05): who planned it, which calendar service carries it, when it starts and how many are invited. Never the title, the agenda or an address. */
export const MeetingsScheduledCreatedEvent = z.object({
  type: z.literal('meetings.scheduled.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  scheduledMeetingId: ScheduledMeetingId,
  organizerId: ActorId,
  provider: ScheduledMeetingProvider,
  startsAt: IsoDateTime,
  attendeeCount: z.number().int().min(0).max(50),
  outsideCount: z.number().int().min(0).max(50),
  at: IsoDateTime,
});
export type MeetingsScheduledCreatedEvent = z.infer<typeof MeetingsScheduledCreatedEvent>;
