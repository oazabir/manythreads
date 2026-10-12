import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { LlmGuardPreset } from '../entities/llm-limits.ts';
import { BotId, WorkspaceId } from '../ids.ts';

/**
 * guardrails-egress refused a call because of where it would go (SPEC §15, PLAN P5-21): `air-gapped` reaches only the local alias, and
 * `strict-egress` only a host the workspace allowlisted. Written for every destination whose caller does not record its own decision
 * (the LLM gateway writes `llm.guard.decided`). `target` is the alias or place the rule judged; `host` is where it would have gone, when known.
 */
export const GuardrailsEgressDecidedEvent = z.object({
  type: z.literal('guardrails.egress.decided'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  destination: z.string().min(1),
  botId: BotId.nullable(),
  preset: LlmGuardPreset,
  outcome: z.literal('block'),
  target: z.string().min(1),
  host: z.string().nullable(),
  at: IsoDateTime,
});
export type GuardrailsEgressDecidedEvent = z.infer<typeof GuardrailsEgressDecidedEvent>;
