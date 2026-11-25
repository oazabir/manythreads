import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MeetingId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * The end-of-call review of a call's action items opened (P17-06 step 2): for which people (those who were in the call and can still read its channel) and how many items it
 * holds. Ids and counts only. The notifications plugin tells each of those people.
 */
export const MeetingsReviewOpenedEvent = z.object({
  type: z.literal('meetings.review.opened'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  meetingId: MeetingId,
  personIds: z.array(PersonId).max(250),
  itemCount: z.number().int().min(1),
  at: IsoDateTime,
});
export type MeetingsReviewOpenedEvent = z.infer<typeof MeetingsReviewOpenedEvent>;
