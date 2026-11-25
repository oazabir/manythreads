import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MeetingGuestId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A link guest answered "Transcribe my voice?" (P17-04 step 2): `yes` lets their own device write their words down, `no` throws away what was stored. Ids only, never
 * the guest's name.
 */
export const MeetingsGuestAnsweredEvent = z.object({
  type: z.literal('meetings.guest.answered'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  guestId: MeetingGuestId,
  value: z.enum(['yes', 'no']),
  at: IsoDateTime,
});
export type MeetingsGuestAnsweredEvent = z.infer<typeof MeetingsGuestAnsweredEvent>;
