import { z } from 'zod';
import { BotId, ChannelId, MessageId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * A person sent a bot the first message of a new conversation: the message is the thread's root and the conversation is indexed
 * (`conversations`, PLAN P5-16). Ids only — never the text. Emitted once per conversation, from the outbox consumer that indexes it.
 *
 * Deliberately carries no `teamId`: the stored event's `team_id` is taken from the payload, and a team-scoped event is readable by every
 * member of the team (`events_select`), which would tell a teammate that — and when — somebody talked to a bot in private. Like a DM's
 * events it is workspace-scoped (`team_id` null), so only a workspace admin's `events_select` reaches it.
 */
export const ConversationsConversationStartedEvent = z.object({
  type: z.literal('conversations.conversation.started'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  botId: BotId,
  personId: PersonId,
  channelId: ChannelId,
  /** The person's message, which is the id of the thread. */
  threadRootId: MessageId,
});
export type ConversationsConversationStartedEvent = z.infer<typeof ConversationsConversationStartedEvent>;
