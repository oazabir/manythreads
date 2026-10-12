import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { WorkspaceId } from '../ids.ts';

/**
 * The workspace's LLM config was pushed to the gateway (PLAN P5-06): an admin changed providers or aliases and the
 * gateway-llm plugin rebuilt the LiteLLM model list and its fallback chains from the database. Carries counts, never a
 * model name or a key.
 */
export const LlmConfigAppliedEvent = z.object({
  type: z.literal('llm.config.applied'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** How many enabled providers the pushed config named. */
  providers: z.number().int().nonnegative(),
  /** How many aliases were bound to a model. */
  aliases: z.number().int().nonnegative(),
  /** How many of those carried at least one fallback. */
  fallbacks: z.number().int().nonnegative(),
  appliedAt: IsoDateTime,
});
export type LlmConfigAppliedEvent = z.infer<typeof LlmConfigAppliedEvent>;
