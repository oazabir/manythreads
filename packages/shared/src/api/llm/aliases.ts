import { z } from 'zod';
import { LlmAlias, LlmAliasName } from '../../entities/llm.ts';
import type { ApiRoute } from '../client/route.ts';

// Workspace → LLM → Providers & aliases, the alias half (SPEC §10.1, PLAN P5-06). An alias is the vocabulary a BOT.md
// speaks: `smart`, `fast`, `code`, `local`, `embed`, `vision`, `image`, `transcribe`. Setting one binds it to a model and
// lists the aliases to fall back to; a fallback chain that names an alias not bound yet is allowed (it may be bound next).

export const LlmAliasPathParams = z.object({ alias: LlmAliasName });

/** Bind an alias. `model` carries its provider prefix or names `providerId`; `fallbacks` are tried in order. */
export const SetLlmAliasRequest = z.strictObject({
  providerId: z.uuid().nullable().optional(),
  model: z.string().trim().min(1, 'Name the model.').max(200),
  /** At most three fallbacks, each a different alias, no repeats (LiteLLM rejects a cycle at load). */
  fallbacks: z.array(LlmAliasName).max(3).optional(),
});
export type SetLlmAliasRequest = z.infer<typeof SetLlmAliasRequest>;

export const ListLlmAliasesResponse = z.object({ aliases: z.array(LlmAlias) });
export type ListLlmAliasesResponse = z.infer<typeof ListLlmAliasesResponse>;

export const LlmAliasResponse = z.object({ alias: LlmAlias });
export type LlmAliasResponse = z.infer<typeof LlmAliasResponse>;

export const DeleteLlmAliasResponse = z.object({ ok: z.literal(true) });
export type DeleteLlmAliasResponse = z.infer<typeof DeleteLlmAliasResponse>;

export const listLlmAliasesRoute = { method: 'GET', path: '/api/workspace/llm/aliases' } as const satisfies ApiRoute;
export const setLlmAliasRoute = { method: 'PUT', path: '/api/workspace/llm/aliases/:alias' } as const satisfies ApiRoute;
export const deleteLlmAliasRoute = { method: 'DELETE', path: '/api/workspace/llm/aliases/:alias' } as const satisfies ApiRoute;
