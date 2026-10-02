import { z } from 'zod';
import { ChannelId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

/** A person joined a channel (`self: true`) or was added to it. Adding someone to a private channel is the audit trail of who sees it. */
export const ChannelMemberAddedEvent = z.object({
  type: z.literal('channel.member.added'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  personId: PersonId,
  self: z.boolean(),
});
export type ChannelMemberAddedEvent = z.infer<typeof ChannelMemberAddedEvent>;
