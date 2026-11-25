import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MeetingGuestId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A link guest is no longer in the call or the waiting room (P17-04): they left, their page went silent (`dropped`), the call ended, or nobody answered their
 * knock in time (`expired`). Ids only.
 */
export const MeetingsGuestLeftEvent = z.object({
  type: z.literal('meetings.guest.left'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  guestId: MeetingGuestId,
  how: z.enum(['left', 'dropped', 'ended', 'expired']),
  at: IsoDateTime,
});
export type MeetingsGuestLeftEvent = z.infer<typeof MeetingsGuestLeftEvent>;
