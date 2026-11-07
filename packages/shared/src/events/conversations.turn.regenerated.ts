import { z } from 'zod';
import { BotId, ChannelId, MessageId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * A person asked for another answer to one of their messages (PLAN P20-16: Regenerate, and Edit then resend). The bot's runtime listens and starts a
 * run for that message; its reply becomes one more variant of the turn. Ids and the alias only. Workspace-scoped like `conversations.conversation.started`.
 */
export const ConversationsTurnRegeneratedEvent = z.object({
  type: z.literal('conversations.turn.regenerated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  botId: BotId,
  personId: PersonId,
  channelId: ChannelId,
  threadRootId: MessageId,
  /** The person's message that gets another answer. */
  turnMessageId: MessageId,
  /** The model alias picked for this run, already checked against the bot's list; null means the bot's first alias. */
  modelAlias: z.string().nullable(),
});
export type ConversationsTurnRegeneratedEvent = z.infer<typeof ConversationsTurnRegeneratedEvent>;
