import { z } from 'zod';
import { LlmAliasName } from '../entities/llm.ts';
import { LlmAliasTestCause, LlmAliasTestOutcome } from '../api/llm/tests.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/**
 * An admin sent a test question through a model alias (PLAN P10-01 step 2). Carries the alias, whether it worked and, when it did not, the cause as a
 * short code. Never the question, the answer, a model name or a key.
 */
export const LlmAliasTestedEvent = z.object({
  type: z.literal('llm.alias.tested'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  alias: LlmAliasName,
  outcome: LlmAliasTestOutcome,
  cause: LlmAliasTestCause.nullable(),
  testedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type LlmAliasTestedEvent = z.infer<typeof LlmAliasTestedEvent>;
