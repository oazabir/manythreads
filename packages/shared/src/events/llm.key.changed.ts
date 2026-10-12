import { z } from 'zod';
import { BotId, WorkspaceId } from '../ids.ts';

/**
 * A bot's gateway virtual key was minted, had its allowed aliases changed (`updated`) or was revoked (PLAN P5-06: "virtual key per bot, minted and deleted with it"). The
 * key itself is never in the event; `keyPrefix` is the non-secret head shown in the workspace page.
 */
export const LlmKeyChangedEvent = z.object({
  type: z.literal('llm.key.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  botId: BotId,
  action: z.enum(['minted', 'updated', 'revoked']),
  /** The visible head of the key (e.g. `sk-abc…`), or null after a revoke. */
  keyPrefix: z.string().nullable(),
});
export type LlmKeyChangedEvent = z.infer<typeof LlmKeyChangedEvent>;
