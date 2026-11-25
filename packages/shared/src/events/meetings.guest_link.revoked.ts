import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingGuestLinkId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * Guest links of a call stopped working (P17-04): turned off by a person (the starter, a lead or an admin), or because the call ended. `linkIds` are the links that
 * were still working; `revokedBy` is null when the call ended.
 */
export const MeetingsGuestLinkRevokedEvent = z.object({
  type: z.literal('meetings.guest_link.revoked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  linkIds: z.array(MeetingGuestLinkId).max(100),
  revokedBy: ActorId.nullable(),
  reason: z.enum(['person', 'ended']),
  at: IsoDateTime,
});
export type MeetingsGuestLinkRevokedEvent = z.infer<typeof MeetingsGuestLinkRevokedEvent>;
