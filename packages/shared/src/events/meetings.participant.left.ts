import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A person is no longer in a voice room (P15-03). `left`: they pressed Leave. `kicked`: they lost the right to be there (removed from the channel or the team) and
 * the media server dropped them. `dropped`: the media server or the missing heartbeat says they are gone. `ended`: the room was closed with them in it.
 */
export const MeetingsParticipantLeftEvent = z.object({
  type: z.literal('meetings.participant.left'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  actorId: ActorId,
  how: z.enum(['left', 'kicked', 'dropped', 'ended']),
  at: IsoDateTime,
});
export type MeetingsParticipantLeftEvent = z.infer<typeof MeetingsParticipantLeftEvent>;
