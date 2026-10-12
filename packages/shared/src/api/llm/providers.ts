import { z } from 'zod';
import { LlmProvider, LlmProviderKind } from '../../entities/llm.ts';
import { IsoDateTime } from '../../common/time.ts';
import type { ApiRoute } from '../client/route.ts';

// Workspace → LLM → Providers & aliases (SPEC §10.1, PLAN P5-06). Workspace owners and admins only; every other caller
// gets 404 (the workspace-settings convention). The API key goes in once and is never read back — the response says only
// whether one is stored (`hasSecret`).

export const LlmProviderPathParams = z.object({ providerId: z.uuid() });

/** The admin's label plus the endpoint. `apiKey` is written to the secret service and never returned. */
export const CreateLlmProviderRequest = z.strictObject({
  name: z.string().trim().min(1, 'Name the provider.').max(80),
  kind: LlmProviderKind,
  /** Stored and used as the calls' bearer credential. Optional for a keyless endpoint (a local Ollama). */
  apiKey: z.string().min(1).optional(),
  apiBase: z.string().url().max(300).optional(),
  apiVersion: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  /** "Runs inside this deployment — never egress": see `LlmProvider.local`. Default false. */
  local: z.boolean().optional(),
});
export type CreateLlmProviderRequest = z.infer<typeof CreateLlmProviderRequest>;

/** Only the fields present change; at least one is required. An empty `apiKey` clears the stored secret. */
export const UpdateLlmProviderRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    apiKey: z.string().optional(),
    apiBase: z.string().url().max(300).nullable().optional(),
    apiVersion: z.string().trim().min(1).max(60).nullable().optional(),
    enabled: z.boolean().optional(),
    local: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Change at least one field.' });
export type UpdateLlmProviderRequest = z.infer<typeof UpdateLlmProviderRequest>;

export const ListLlmProvidersResponse = z.object({ providers: z.array(LlmProvider) });
export type ListLlmProvidersResponse = z.infer<typeof ListLlmProvidersResponse>;

export const LlmProviderResponse = z.object({ provider: LlmProvider });
export type LlmProviderResponse = z.infer<typeof LlmProviderResponse>;

export const DeleteLlmProviderResponse = z.object({ ok: z.literal(true), deletedAt: IsoDateTime });
export type DeleteLlmProviderResponse = z.infer<typeof DeleteLlmProviderResponse>;

export const listLlmProvidersRoute = { method: 'GET', path: '/api/workspace/llm/providers' } as const satisfies ApiRoute;
export const createLlmProviderRoute = { method: 'POST', path: '/api/workspace/llm/providers' } as const satisfies ApiRoute;
export const updateLlmProviderRoute = { method: 'PATCH', path: '/api/workspace/llm/providers/:providerId' } as const satisfies ApiRoute;
export const deleteLlmProviderRoute = { method: 'DELETE', path: '/api/workspace/llm/providers/:providerId' } as const satisfies ApiRoute;
