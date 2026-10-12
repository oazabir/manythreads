import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { LlmSpendSummary } from '../../entities/llm-limits.ts';
import type { ApiRoute } from '../client/route.ts';

// Workspace → LLM → Spend (SPEC §10.1 "observability", PLAN P5-07 `llm_spend`). Admin only; the default range is the
// current month, which is the window a monthly budget uses.

export const LlmSpendQuery = z.object({
  since: IsoDateTime.optional(),
  until: IsoDateTime.optional(),
});
export type LlmSpendQuery = z.infer<typeof LlmSpendQuery>;

export const LlmSpendResponse = z.object({ summary: LlmSpendSummary });
export type LlmSpendResponse = z.infer<typeof LlmSpendResponse>;

export const listLlmSpendRoute = { method: 'GET', path: '/api/workspace/llm/spend' } as const satisfies ApiRoute;
