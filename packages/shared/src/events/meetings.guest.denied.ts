import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingGuestId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A person in the call turned a knocking link guest away (P17-04). Ids only.
 */
export const MeetingsGuestDeniedEvent = z.object({
  type: z.literal('meetings.guest.denied'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  guestId: MeetingGuestId,
  decidedBy: ActorId,
  at: IsoDateTime,
});
export type MeetingsGuestDeniedEvent = z.infer<typeof MeetingsGuestDeniedEvent>;
