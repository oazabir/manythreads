import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, MeetingShareRequestId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A request for a turn to share a screen was answered (P17-02): `accept` (the person asked stops sharing), `decline` ("Not now"), or `other` (they said yes to
 * someone else's request, which turned this one down). This is the only event of a request: one that was never answered (the person asked was not sharing, or
 * let it lapse) leaves no event and no audit row, so requests sent to someone who is not sharing cannot fill the audit log.
 */
export const MeetingsShareRequestAnsweredEvent = z.object({
  type: z.literal('meetings.share_request.answered'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  requestId: MeetingShareRequestId,
  answeredBy: ActorId,
  askedBy: ActorId,
  answer: z.enum(['accept', 'decline', 'other']),
  at: IsoDateTime,
});
export type MeetingsShareRequestAnsweredEvent = z.infer<typeof MeetingsShareRequestAnsweredEvent>;
