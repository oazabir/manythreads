import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { MeetingKind } from '../entities/meeting.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A voice room was opened (P15-03). Ids and the time: never the title, which a person wrote. `teamId` is null for a call in a direct message, so only the people of
 * that conversation can follow it. A person joining a live room is `meetings.participant.joined`.
 */
export const MeetingsMeetingStartedEvent = z.object({
  type: z.literal('meetings.meeting.started'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  startedBy: ActorId,
  /** Audio or video (P15-25); absent in events written before calls had a kind, which were all audio. */
  kind: MeetingKind.optional(),
  at: IsoDateTime,
});
export type MeetingsMeetingStartedEvent = z.infer<typeof MeetingsMeetingStartedEvent>;
