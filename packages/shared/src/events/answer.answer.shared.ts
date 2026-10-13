import { z } from 'zod';
import { BotId, ChannelId, MessageId, PersonId, RunId, WorkspaceId } from '../ids.ts';

/**
 * A person did something with an answer of their own conversation that makes its content reach other people (SPEC §6.3, PLAN P5-17): `channel`
 * posted a masked copy into a channel, `page` saved one as a team page, `handoff` gave it to another bot. The access event of the share: who, which
 * answer, to where, and how it was cut — **ids and counts only**. It never carries a citation's id, label, snippet or `teamId`: what a masked
 * source was is exactly what the event must not say, and the team of a private source is itself something readers may not know.
 *
 * Deliberately carries no `teamId`, like `answer.answer.posted`: it is workspace-scoped, so only an admin's policy reaches it (a team-scoped event
 * row is readable by every member of the team, and the answer it names is a person's private conversation).
 */
export const AnswerAnswerSharedEvent = z.object({
  type: z.literal('answer.answer.shared'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** `channel`: a copy posted into `channelId`. `page`: a page saved from the answer. `handoff`: the answer handed to another bot in `channelId`. */
  kind: z.enum(['channel', 'page', 'handoff']),
  /** The person who shared: the asker, and only the asker may. */
  personId: PersonId,
  botId: BotId,
  runId: RunId,
  /** The answer, in the sharer's own conversation. */
  messageId: MessageId,
  /** Where it went: the target channel (a conversation with another bot, for a hand-off); null for a page. */
  channelId: ChannelId.nullable(),
  /** The copy that was posted (a hand-off's first message); null for a page, whose file is named by `pages.page.written`. */
  copyMessageId: MessageId.nullable(),
  /** Citations the copy kept as they were. */
  keptCount: z.number().int().nonnegative(),
  /** Citations replaced by "not shared". */
  maskedCount: z.number().int().nonnegative(),
  /** Claims the sharer took out before posting. */
  removedCount: z.number().int().nonnegative(),
  /** Which citations (their numbers in the answer, never ids) were masked and which removed. */
  maskedNumbers: z.array(z.number().int().min(1).max(40)).max(40),
  removedNumbers: z.array(z.number().int().min(1).max(40)).max(40),
});
export type AnswerAnswerSharedEvent = z.infer<typeof AnswerAnswerSharedEvent>;
