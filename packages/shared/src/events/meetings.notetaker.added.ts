import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, BotId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A bot was added to a voice room as its note-taker (P15-18). Ids only. */
export const MeetingsNotetakerAddedEvent = z.object({
  type: z.literal('meetings.notetaker.added'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  botId: BotId,
  /** The person who added it. */
  addedBy: ActorId,
  at: IsoDateTime,
});
export type MeetingsNotetakerAddedEvent = z.infer<typeof MeetingsNotetakerAddedEvent>;
