import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MessageId, PollId, TeamId, WorkspaceId } from '../ids.ts';

/** A poll was posted (P14-07). The question and the options are the message's text and are not repeated here: ids and the poll's rules only. */
export const ChannelPollCreatedEvent = z.object({
  type: z.literal('channel.poll.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  pollId: PollId,
  messageId: MessageId,
  authorId: ActorId,
  optionCount: z.number().int().min(2).max(10),
  multiple: z.boolean(),
  anonymous: z.boolean(),
  closesAt: IsoDateTime.nullable(),
});
export type ChannelPollCreatedEvent = z.infer<typeof ChannelPollCreatedEvent>;
