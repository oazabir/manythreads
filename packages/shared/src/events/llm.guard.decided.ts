import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { LlmGuardOutcome, LlmGuardPreset } from '../entities/llm-limits.ts';
import { LlmAliasName } from '../entities/llm.ts';
import { BotId, WorkspaceId } from '../ids.ts';

/**
 * The gateway's pre-call hook decided something about a call (SPEC §15, PLAN P5-07 "pre-call DLP hook with standard").
 * Emitted on every decision that is not `allow`, and on a preset refusal; the rule names say what was found (a detector
 * name such as `api-key`), never the matched text.
 */
export const LlmGuardDecidedEvent = z.object({
  type: z.literal('llm.guard.decided'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  botId: BotId.nullable(),
  alias: LlmAliasName,
  preset: LlmGuardPreset,
  outcome: LlmGuardOutcome,
  /** The detectors that fired, in the order they ran; empty for a preset-only refusal. */
  rules: z.array(z.string()),
  /** Why the call was refused, when it was (`preset` or `dlp`). */
  reason: z.enum(['preset', 'dlp']).nullable(),
  at: IsoDateTime,
});
export type LlmGuardDecidedEvent = z.infer<typeof LlmGuardDecidedEvent>;
