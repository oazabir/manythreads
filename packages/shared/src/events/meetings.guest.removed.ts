import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingGuestId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A person in the call took a link guest out (P17-04); the guest's credential is dead from then on. Ids only.
 */
export const MeetingsGuestRemovedEvent = z.object({
  type: z.literal('meetings.guest.removed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  guestId: MeetingGuestId,
  decidedBy: ActorId,
  at: IsoDateTime,
});
export type MeetingsGuestRemovedEvent = z.infer<typeof MeetingsGuestRemovedEvent>;
