import { z } from 'zod';
import { ActorId, ChannelId, MessageId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A message names a person (`@handle`): written once per person the first time a body mentions them, so an edit that keeps the mention
 * does not announce it again (the notifications plugin turns these into the mention inbox). Only people who can read the channel and
 * are not the author count. `mentionedId` is the person's actor id (the id `message_mentions` stores); `personId` is the same person
 * in `people`. `kind: 'bot'` is for `@bot` once bots exist. Payloads carry ids, never message text.
 */
export const ChannelMentionCreatedEvent = z.object({
  type: z.literal('channel.mention.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  messageId: MessageId,
  threadRootId: MessageId.nullable(),
  authorId: ActorId,
  kind: z.enum(['person', 'bot']),
  mentionedId: ActorId,
  personId: PersonId.nullable(),
});
export type ChannelMentionCreatedEvent = z.infer<typeof ChannelMentionCreatedEvent>;
