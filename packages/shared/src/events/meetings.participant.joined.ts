import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A person came into a voice room (P15-03). `rejoined` is true when they had been in this room before and left. */
export const MeetingsParticipantJoinedEvent = z.object({
  type: z.literal('meetings.participant.joined'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  actorId: ActorId,
  rejoined: z.boolean(),
  at: IsoDateTime,
});
export type MeetingsParticipantJoinedEvent = z.infer<typeof MeetingsParticipantJoinedEvent>;
