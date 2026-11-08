import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A room's note-taker bot left: removed by the organizer or a lead, or the room ended (P15-18). Ids only. */
export const MeetingsNotetakerRemovedEvent = z.object({
  type: z.literal('meetings.notetaker.removed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  botId: BotId,
  /** The person who removed it; null when it left because the room ended. */
  removedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MeetingsNotetakerRemovedEvent = z.infer<typeof MeetingsNotetakerRemovedEvent>;
