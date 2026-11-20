import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { CALL_INVITES_MAX } from '../entities/meeting.ts';
import { ActorId, ChannelId, MeetingId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * People were asked to a live call (P15-27): when the call starts (`first: true`) or later with "Invite more" (`first: false`). Only the people newly asked, never the ones
 * asked before or the caller. Ids and the time only: the notifications plugin reads the title from the meeting. An invitation decides who is told, not who may join.
 */
export const MeetingsInviteSentEvent = z.object({
  type: z.literal('meetings.invite.sent'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  meetingId: MeetingId,
  invitedBy: ActorId,
  personIds: z.array(PersonId).min(1).max(CALL_INVITES_MAX),
  first: z.boolean(),
  at: IsoDateTime,
});
export type MeetingsInviteSentEvent = z.infer<typeof MeetingsInviteSentEvent>;
