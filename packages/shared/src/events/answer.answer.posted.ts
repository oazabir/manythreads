import { z } from 'zod';
import { BotId, ChannelId, MessageId, PersonId, RunId, WorkspaceId } from '../ids.ts';

/**
 * A bot finished a reply with an Answer (`answer.post`, PLAN P5-18): one event per answer, in the transaction that posted its message. Ids and
 * counts only — never the text, a title or a snippet of what was cited or left out.
 *
 * Deliberately carries no `teamId`, like `conversations.conversation.started`: an answer to a person's private conversation is that person's,
 * and the stored event's `team_id` is what every member of the team may read. Workspace-scoped, so only an admin's policy reaches it.
 *
 * `droppedCount` is how many citations the platform removed because the person who asked could not read them, or because the people who
 * read the reply could not: the audit line for "what the answer could not rest on" (§15).
 */
export const AnswerAnswerPostedEvent = z.object({
  type: z.literal('answer.answer.posted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  botId: BotId,
  runId: RunId,
  /** The person who asked; null for a run nobody asked. */
  askerPersonId: PersonId.nullable(),
  channelId: ChannelId,
  messageId: MessageId,
  threadRootId: MessageId.nullable(),
  citationCount: z.number().int().nonnegative(),
  droppedCount: z.number().int().nonnegative(),
  reachedCount: z.number().int().nonnegative(),
});
export type AnswerAnswerPostedEvent = z.infer<typeof AnswerAnswerPostedEvent>;
