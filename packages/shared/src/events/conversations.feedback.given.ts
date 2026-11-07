import { z } from 'zod';
import { BotId, ChannelId, MessageId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * A person put a thumb on a bot's answer in their own conversation, changed it, or took it back (PLAN P20-16). Ids and the vote only: the one-line
 * reason lives in `conversation_feedback`, which only the person reads, so it is never in the event log. The eval harness reads this event to learn
 * which answers people liked. Like `conversations.conversation.started` it carries no `teamId` (workspace-scoped), so a teammate cannot tell
 * that somebody rated a bot's answer in private.
 */
export const ConversationsFeedbackGivenEvent = z.object({
  type: z.literal('conversations.feedback.given'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  botId: BotId,
  personId: PersonId,
  channelId: ChannelId,
  /** The bot's answer. */
  messageId: MessageId,
  /** `none` when the person took the thumb back. */
  vote: z.enum(['up', 'down', 'none']),
});
export type ConversationsFeedbackGivenEvent = z.infer<typeof ConversationsFeedbackGivenEvent>;
