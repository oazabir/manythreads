import { z } from 'zod';
import { ChannelId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

/** A person left a channel (`self: true`) or was removed from it. */
export const ChannelMemberRemovedEvent = z.object({
  type: z.literal('channel.member.removed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  personId: PersonId,
  self: z.boolean(),
});
export type ChannelMemberRemovedEvent = z.infer<typeof ChannelMemberRemovedEvent>;
