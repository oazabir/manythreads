import { z } from 'zod';
import { ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';

/** A stand-up's digest was posted in its channel (P18-04): the runtime wakes the stand-up bot in the digest's thread to put each blocker on the board. No answer text rides along. */
export const ChannelStandupDigestedEvent = z.object({
  type: z.literal('channel.standup.digested'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  standupId: z.uuid(),
  channelId: ChannelId,
  digestMessageId: MessageId,
  botId: z.uuid(),
  answered: z.number().int().min(0),
});
export type ChannelStandupDigestedEvent = z.infer<typeof ChannelStandupDigestedEvent>;
