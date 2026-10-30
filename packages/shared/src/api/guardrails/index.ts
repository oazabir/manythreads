import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';
import { DlpCustomRule } from '../../entities/guardrails.ts';

// Workspace > Data protection (PLAN P10-04). Workspace owners and admins only; every route answers 403 to anyone else.

export const getDlpPolicyRoute = { method: 'GET', path: '/api/admin/guardrails/dlp' } as const satisfies ApiRoute;
export const setDlpDetectorRoute = { method: 'PUT', path: '/api/admin/guardrails/dlp/detectors/:name' } as const satisfies ApiRoute;
export const createDlpRuleRoute = { method: 'POST', path: '/api/admin/guardrails/dlp/rules' } as const satisfies ApiRoute;
export const updateDlpRuleRoute = { method: 'PATCH', path: '/api/admin/guardrails/dlp/rules/:ruleId' } as const satisfies ApiRoute;
export const deleteDlpRuleRoute = { method: 'DELETE', path: '/api/admin/guardrails/dlp/rules/:ruleId' } as const satisfies ApiRoute;
export const testDlpRoute = { method: 'POST', path: '/api/admin/guardrails/dlp/test' } as const satisfies ApiRoute;
export const listTeamEgressRoute = { method: 'GET', path: '/api/admin/guardrails/egress' } as const satisfies ApiRoute;
export const setTeamEgressRoute = { method: 'PUT', path: '/api/admin/guardrails/egress/:teamId' } as const satisfies ApiRoute;

export const DlpRuleResponse = z.object({ rule: DlpCustomRule });
export type DlpRuleResponse = z.infer<typeof DlpRuleResponse>;
export const DeleteDlpRuleResponse = z.object({ ok: z.literal(true) });
export type DeleteDlpRuleResponse = z.infer<typeof DeleteDlpRuleResponse>;
