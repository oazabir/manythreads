import { z } from 'zod';
import { LlmBudgetWindow, LlmGuardPreset, LlmLimit, LlmLimitScope, LlmWorkspaceSettings } from '../../entities/llm-limits.ts';
import type { ApiRoute } from '../client/route.ts';

// Workspace → LLM → Budgets, rate limits and the guard preset (SPEC §10.1, PLAN P5-07). Admins only, like the provider
// routes: a budget is a workspace-wide policy. The web page that draws this is P5-08.

export const LlmLimitPathParams = z.object({ limitId: z.uuid() });

/**
 * Set a limit at one scope: the row is upserted on its target, so setting the workspace budget twice changes it rather
 * than adding a second one. At least one cap must be present (`limitUsd` or `requestsPerMinute`); passing null for both
 * is refused — delete the row instead.
 */
export const SetLlmLimitRequest = z
  .strictObject({
    scope: LlmLimitScope,
    teamId: z.uuid().nullable().optional(),
    botId: z.uuid().nullable().optional(),
    window: LlmBudgetWindow.optional(),
    /** The spend cap in USD; null clears a cap the row had (as long as a rate limit remains). */
    limitUsd: z.number().nonnegative().max(1_000_000).nullable().optional(),
    requestsPerMinute: z.number().int().positive().max(100_000).nullable().optional(),
  })
  .refine(
    (v) =>
      (v.scope === 'team' && !!v.teamId) ||
      ((v.scope === 'bot' || v.scope === 'session') && !!v.botId) ||
      v.scope === 'workspace',
    { message: 'The scope needs its target: teamId for a team, botId for a bot or a session, none for the workspace.' },
  );
export type SetLlmLimitRequest = z.infer<typeof SetLlmLimitRequest>;

export const ListLlmLimitsResponse = z.object({ limits: z.array(LlmLimit) });
export type ListLlmLimitsResponse = z.infer<typeof ListLlmLimitsResponse>;

export const LlmLimitResponse = z.object({ limit: LlmLimit });
export type LlmLimitResponse = z.infer<typeof LlmLimitResponse>;

export const DeleteLlmLimitResponse = z.object({ ok: z.literal(true) });
export type DeleteLlmLimitResponse = z.infer<typeof DeleteLlmLimitResponse>;

/** Change the workspace's guard preset, its egress allowlist or its caching flag; at least one field is required. */
export const SetLlmSettingsRequest = z
  .strictObject({
    preset: LlmGuardPreset.optional(),
    /** Hosts (no scheme, optional port) the `strict-egress` preset lets a call reach. */
    egressAllowlist: z.array(z.string().trim().min(1).max(255)).max(100).optional(),
    caching: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Change at least one field.' });
export type SetLlmSettingsRequest = z.infer<typeof SetLlmSettingsRequest>;

export const LlmSettingsResponse = z.object({ settings: LlmWorkspaceSettings });
export type LlmSettingsResponse = z.infer<typeof LlmSettingsResponse>;

export const listLlmLimitsRoute = { method: 'GET', path: '/api/workspace/llm/limits' } as const satisfies ApiRoute;
export const setLlmLimitRoute = { method: 'PUT', path: '/api/workspace/llm/limits' } as const satisfies ApiRoute;
export const deleteLlmLimitRoute = { method: 'DELETE', path: '/api/workspace/llm/limits/:limitId' } as const satisfies ApiRoute;
export const getLlmSettingsRoute = { method: 'GET', path: '/api/workspace/llm/settings' } as const satisfies ApiRoute;
export const setLlmSettingsRoute = { method: 'PUT', path: '/api/workspace/llm/settings' } as const satisfies ApiRoute;
