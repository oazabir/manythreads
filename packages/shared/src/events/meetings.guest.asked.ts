import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MeetingGuestId, MeetingGuestLinkId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * Someone opened a guest link and knocked (P17-04). Ids only: never the name they typed, never their address.
 */
export const MeetingsGuestAskedEvent = z.object({
  type: z.literal('meetings.guest.asked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  guestId: MeetingGuestId,
  linkId: MeetingGuestLinkId,
  at: IsoDateTime,
});
export type MeetingsGuestAskedEvent = z.infer<typeof MeetingsGuestAskedEvent>;
