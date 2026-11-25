import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingGuestLinkId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A member made a guest link of their own for a live call (P17-04): ids and times only. The link's secret is never in an event.
 */
export const MeetingsGuestLinkCreatedEvent = z.object({
  type: z.literal('meetings.guest_link.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  linkId: MeetingGuestLinkId,
  createdBy: ActorId,
  expiresAt: IsoDateTime,
  at: IsoDateTime,
});
export type MeetingsGuestLinkCreatedEvent = z.infer<typeof MeetingsGuestLinkCreatedEvent>;
