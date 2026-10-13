import { z } from 'zod';
import { BotId, ChannelId, MessageId, PersonId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A person sent a bot the first message of a new conversation: the message is the thread's root and the conversation is indexed
 * (`conversations`, PLAN P5-16). Ids only — never the text. Emitted once per conversation, from the outbox consumer that indexes it.
 */
export const ConversationsConversationStartedEvent = z.object({
  type: z.literal('conversations.conversation.started'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  personId: PersonId,
  channelId: ChannelId,
  /** The person's message, which is the id of the thread. */
  threadRootId: MessageId,
});
export type ConversationsConversationStartedEvent = z.infer<typeof ConversationsConversationStartedEvent>;
