import { z } from 'zod';
import { BotId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A `bots/<slug>/BOT.md` definition loaded: the outbox loader (PLAN P5-04) built or refreshed the bot's row from the file at this commit.
 * Carries ids, the path and the sha256 of the file it was built from, never the content; `mayTag` is the handover allowlist compiled into the
 * bot's `tasks.handoff` grant (empty when the file declares no `handover.mayTag`).
 */
export const BotsBotLoadedEvent = z.object({
  type: z.literal('bots.bot.loaded'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  path: z.string().min(1),
  definitionSha: z.string().regex(/^[0-9a-f]{64}$/),
  mayTag: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)),
});
export type BotsBotLoadedEvent = z.infer<typeof BotsBotLoadedEvent>;
