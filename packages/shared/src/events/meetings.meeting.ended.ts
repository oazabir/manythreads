import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { MeetingEndReason } from '../entities/meeting.ts';
import { ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/** A voice room was closed (P15-03): by a person (`endedBy` is who) or by itself after the last person left (`endedBy` null, reason `empty`). */
export const MeetingsMeetingEndedEvent = z.object({
  type: z.literal('meetings.meeting.ended'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  endedBy: z.uuid().nullable(),
  reason: MeetingEndReason,
  /** How long the room was open, in whole seconds. */
  durationSeconds: z.number().int().min(0),
  /** How many different people were in it at some point. */
  participantCount: z.number().int().min(0),
  at: IsoDateTime,
});
export type MeetingsMeetingEndedEvent = z.infer<typeof MeetingsMeetingEndedEvent>;
