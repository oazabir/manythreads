import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * The people of a finished call confirmed its action items (P17-06 step 2): who pressed Confirm, how many were kept and removed, and the people they were given to. Ids and
 * counts only, never an item's words. The follow-ups (P17-07) start from it.
 */
export const MeetingsActionItemsConfirmedEvent = z.object({
  type: z.literal('meetings.action_items.confirmed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId.nullable(),
  meetingId: MeetingId,
  confirmedBy: ActorId,
  /** Items kept. */
  itemCount: z.number().int().min(0),
  /** Items of the review that were removed. */
  removedCount: z.number().int().min(0),
  /** The people the kept items were given to, once each. */
  ownerIds: z.array(ActorId).max(50).default([]),
  at: IsoDateTime,
});
export type MeetingsActionItemsConfirmedEvent = z.infer<typeof MeetingsActionItemsConfirmedEvent>;
