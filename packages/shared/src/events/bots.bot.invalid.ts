import { z } from 'zod';
import { BotId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A `bots/<slug>/BOT.md` definition failed to load (PLAN P5-04): unknown or missing keys, bad YAML, or a folder that is not a lowercase
 * slug. The previous definition stays live — `botId` is the row that keeps running (null when the file never loaded once) — and the reason
 * rides here: `fieldPath` is the field the schema named (`capabilities.native[3]`) when it could name one, `message` is what the bot page's
 * red banner shows. The event is the alert; no error column is kept on the row.
 */
export const BotsBotInvalidEvent = z.object({
  type: z.literal('bots.bot.invalid'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: BotId.nullable(),
  slug: z.string().min(1),
  path: z.string().min(1),
  definitionSha: z.string().regex(/^[0-9a-f]{64}$/),
  fieldPath: z.string().nullable(),
  message: z.string().min(1).max(2000),
});
export type BotsBotInvalidEvent = z.infer<typeof BotsBotInvalidEvent>;
