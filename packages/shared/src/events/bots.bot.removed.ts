import { z } from 'zod';
import { BotId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * The `bots/<slug>/BOT.md` file was deleted from a team repo: the bot's row went with it (pairing tokens and runs cascade; the actor row
 * stays, because messages it wrote reference it, but its capability grants are deleted with the definition). PLAN P5-04.
 */
export const BotsBotRemovedEvent = z.object({
  type: z.literal('bots.bot.removed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
});
export type BotsBotRemovedEvent = z.infer<typeof BotsBotRemovedEvent>;
