import { z } from 'zod';
import { ActorId, ChannelId, MessageId, RunId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * The server repaired the Markdown of a bot's message before it was saved (PLAN P14-19): `paths` file names or paths that were not in backticks were
 * wrapped, and `fences` is 1 when a code block the bot opened and never closed was closed. Written only when something was changed, by the bot that
 * wrote the message, so a bot that keeps slipping shows on its page (the count of repairs on each run). `via` says whether the text was a new post or an
 * edit of the bot's own message. Counts only: never the text, never the path.
 */
export const ChannelMarkdownRepairedEvent = z.object({
  type: z.literal('channel.markdown.repaired'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId,
  teamId: TeamId.nullable(),
  messageId: MessageId,
  /** The bot that wrote the text. */
  botActorId: ActorId,
  /** The run the message belongs to, or null for a message written outside a run. */
  runId: RunId.nullable(),
  via: z.enum(['post', 'update']),
  paths: z.number().int().nonnegative(),
  fences: z.number().int().nonnegative(),
});
export type ChannelMarkdownRepairedEvent = z.infer<typeof ChannelMarkdownRepairedEvent>;
