import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingGuestId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A person in the call let a link guest in (P17-04). Ids only.
 */
export const MeetingsGuestAdmittedEvent = z.object({
  type: z.literal('meetings.guest.admitted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  guestId: MeetingGuestId,
  decidedBy: ActorId,
  at: IsoDateTime,
});
export type MeetingsGuestAdmittedEvent = z.infer<typeof MeetingsGuestAdmittedEvent>;
