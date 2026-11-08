import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** The organizer shared a meeting's notes with a person or a channel, or took the share back (P15-22). Ids only. */
export const MeetingsNotesSharedEvent = z.object({
  type: z.literal('meetings.notes.shared'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  /** The person who shared (the organizer). */
  sharedBy: ActorId,
  granteeKind: z.enum(['person', 'channel']),
  /** The person's or the channel's id. */
  granteeId: z.string().uuid(),
  revoked: z.boolean(),
  at: IsoDateTime,
});
export type MeetingsNotesSharedEvent = z.infer<typeof MeetingsNotesSharedEvent>;
