import { z } from 'zod';
import { BotId, ChannelId, MessageId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * A conversation got a new title (PLAN P20-16): the person renamed it (`manual`) or the `fast` model named it from the first exchange (`auto`). Ids only,
 * never the title. Workspace-scoped like `conversations.conversation.started`.
 */
export const ConversationsConversationRenamedEvent = z.object({
  type: z.literal('conversations.conversation.renamed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  botId: BotId,
  personId: PersonId,
  channelId: ChannelId,
  threadRootId: MessageId,
  source: z.enum(['auto', 'manual']),
});
export type ConversationsConversationRenamedEvent = z.infer<typeof ConversationsConversationRenamedEvent>;
