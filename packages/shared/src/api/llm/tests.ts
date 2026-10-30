import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { LlmAliasName } from '../../entities/llm.ts';
import { ActorId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';

// Workspace → LLM → test call per alias (PLAN P10-01 step 2). An admin asks for one small real question to be sent through the whole path (the
// pre-call check, the proxy, the provider) and gets a plain answer: it worked, or why it did not. Only the newest result of each alias is kept, and
// it counts only while neither the alias nor its provider has been changed since (`current`).

export const LlmAliasTestOutcome = z.enum(['ok', 'failed']);
export type LlmAliasTestOutcome = z.infer<typeof LlmAliasTestOutcome>;

/** Why a test failed, in the vocabulary the screen words: the proxy is not set up, the alias is not bound, a limit or a guard refused, the provider refused the key or the model, and so on. */
export const LlmAliasTestCause = z.enum([
  'no_gateway',
  'unbound',
  'refused',
  'auth',
  'model_not_found',
  'rate_limited',
  'provider_error',
  'timeout',
  'unreachable',
  'empty_answer',
  'other',
]);
export type LlmAliasTestCause = z.infer<typeof LlmAliasTestCause>;

/** The aliases that have a text test. The others (an embedding model, an image model, a speech model) answer in another shape and are reported as "not checked". */
export const LLM_TESTABLE_ALIASES = ['smart', 'fast', 'code', 'local', 'vision'] as const satisfies readonly LlmAliasName[];
export const LlmTestableAlias = z.enum(LLM_TESTABLE_ALIASES);
export type LlmTestableAlias = z.infer<typeof LlmTestableAlias>;

export const LlmAliasTest = z.object({
  alias: LlmAliasName,
  outcome: LlmAliasTestOutcome,
  /** Null when it worked. */
  cause: LlmAliasTestCause.nullable(),
  /** One or two plain sentences: what happened and, when it failed, what to look at. Never a key, a prompt or the provider's raw text. */
  message: z.string().min(1).max(500),
  /** The model that answered, as the provider reported it (null when nothing answered). */
  model: z.string().max(200).nullable(),
  latencyMs: z.number().int().nonnegative(),
  testedAt: IsoDateTime,
  testedBy: ActorId.nullable(),
  /** False once the alias or its provider was changed after the test: the result is then history, not a fact about what is configured now. */
  current: z.boolean(),
});
export type LlmAliasTest = z.infer<typeof LlmAliasTest>;

export const TestLlmAliasResponse = z.object({ test: LlmAliasTest });
export type TestLlmAliasResponse = z.infer<typeof TestLlmAliasResponse>;

export const ListLlmAliasTestsResponse = z.object({
  tests: z.array(LlmAliasTest),
  /** Aliases that cannot be tested with a text question, so a screen never shows them as checked. */
  untestable: z.array(LlmAliasName),
});
export type ListLlmAliasTestsResponse = z.infer<typeof ListLlmAliasTestsResponse>;

export const testLlmAliasRoute = { method: 'POST', path: '/api/workspace/llm/aliases/:alias/test' } as const satisfies ApiRoute;
export const listLlmAliasTestsRoute = { method: 'GET', path: '/api/workspace/llm/alias-tests' } as const satisfies ApiRoute;
