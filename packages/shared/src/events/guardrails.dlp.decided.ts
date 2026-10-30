import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { LlmGuardOutcome, LlmGuardPreset } from '../entities/llm-limits.ts';
import { BotId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * guardrails-dlp decided something about text that was about to leave (SPEC §15, PLAN P5-21). Written for every destination whose caller
 * does not record its own decision (the LLM gateway writes `llm.guard.decided`, which also knows the alias), on every outcome but `allow`.
 * The rule names say what was found (`api-key`, `card-number`), never the matched text.
 */
export const GuardrailsDlpDecidedEvent = z.object({
  type: z.literal('guardrails.dlp.decided'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** Where the text was going: `channel`, `email`, `mcp`, ... */
  destination: z.string().min(1),
  botId: BotId.nullable(),
  /** The team of the bot the text left from, when it was a bot's. Optional so an older event still reads. */
  teamId: TeamId.nullable().optional(),
  preset: LlmGuardPreset,
  outcome: LlmGuardOutcome.exclude(['allow']),
  rules: z.array(z.string()).min(1),
  at: IsoDateTime,
});
export type GuardrailsDlpDecidedEvent = z.infer<typeof GuardrailsDlpDecidedEvent>;
