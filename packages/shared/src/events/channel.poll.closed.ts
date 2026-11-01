import { z } from 'zod';
import { ActorId, ChannelId, MessageId, PollId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A poll closed (P14-07): its author closed it early (`reason` author, `closedBy` is them) or its closing time came (`reason` time, `closedBy` null;
 * the minute job writes the event as the poll's author). `voters` is how many people voted; per-option counts are in the result message. The result
 * message is `resultMessageId`, null when it could not be posted (the author can no longer post in the channel). Nothing here says who voted for what.
 */
export const ChannelPollClosedEvent = z.object({
  type: z.literal('channel.poll.closed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  pollId: PollId,
  messageId: MessageId,
  reason: z.enum(['author', 'time']),
  closedBy: ActorId.nullable(),
  voters: z.number().int().nonnegative(),
  resultMessageId: MessageId.nullable(),
});
export type ChannelPollClosedEvent = z.infer<typeof ChannelPollClosedEvent>;
