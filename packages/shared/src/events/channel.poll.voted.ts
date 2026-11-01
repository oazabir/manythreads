import { z } from 'zod';
import { ActorId, ChannelId, MessageId, PollId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * Someone voted, changed their vote or withdrew it in a **named** poll (P14-07). `options` are the options now chosen (numbers into the poll's
 * list), empty after a withdrawal. **An anonymous poll never writes this event**: the event log names the actor and the time of every event, and
 * a log entry "Nadia voted at 10:02" next to a count that rose at 10:02 would tell an admin who chose what. `anonymous` is therefore always
 * false here, and says so to a reader of the log. The other poll events (`created`, `closed`) carry no vote choices in either kind of poll.
 */
export const ChannelPollVotedEvent = z.object({
  type: z.literal('channel.poll.voted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  pollId: PollId,
  messageId: MessageId,
  voterId: ActorId,
  anonymous: z.literal(false),
  options: z.array(z.number().int().min(0).max(9)).max(10),
});
export type ChannelPollVotedEvent = z.infer<typeof ChannelPollVotedEvent>;
