import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { LlmBudgetWindow, LlmLimitScope, LlmRefusalReason } from '../entities/llm-limits.ts';
import { BotId, WorkspaceId } from '../ids.ts';

/**
 * A model call was refused before it left the gateway (PLAN P5-07: budgets and rate limits "enforced before the call").
 * The event names the scope that answered, never the prompt: the audit log records that a call did not happen and why.
 * `reason` is `budget` or `rate`; the preset and DLP refusals travel on `llm.guard.decided`.
 */
export const LlmBudgetExceededEvent = z.object({
  type: z.literal('llm.budget.exceeded'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** The limit's scope and target that the call hit. */
  scope: LlmLimitScope,
  teamId: z.uuid().nullable(),
  botId: BotId.nullable(),
  sessionId: z.string().nullable(),
  reason: LlmRefusalReason,
  window: LlmBudgetWindow.nullable(),
  /** The cap that was hit: dollars for a budget, calls per minute for a rate limit. */
  limitUsd: z.number().nonnegative().nullable(),
  requestsPerMinute: z.number().int().positive().nullable(),
  /** What the scope had already spent or used when the call was refused. */
  spentUsd: z.number().nonnegative().nullable(),
  /** Milliseconds until the caller may retry (a rate limit), or null for a budget. */
  retryAfterMs: z.number().int().nonnegative().nullable(),
  alias: z.string().nullable(),
  at: IsoDateTime,
});
export type LlmBudgetExceededEvent = z.infer<typeof LlmBudgetExceededEvent>;
