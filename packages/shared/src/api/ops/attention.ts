import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';

// The bar at the top of the screen for the people who can fix it (owner request 2026-11-24): a sign-in that Claude Code, Codex or Hermes refused or that is gone, or a model
// key the provider refused, so the bots that depend on it cannot work. Workspace owners and admins only: anyone else gets an empty list.

export const AttentionKind = z.enum(['runner_sign_in', 'model_key']);
export type AttentionKind = z.infer<typeof AttentionKind>;

export const AttentionProblem = z.object({
  kind: AttentionKind,
  /** Stable for the same problem (a runner's id, a provider's id), so a person can hide one for the session and still see a new one. */
  key: z.string().min(1).max(120),
  /** One plain sentence: what stopped working. Never a key, an account or the provider's raw text. */
  text: z.string().min(1).max(300),
  /** Where it is fixed. */
  link: z.string().min(1).max(200),
  /** The button's words. */
  action: z.string().min(1).max(40),
});
export type AttentionProblem = z.infer<typeof AttentionProblem>;

export const GetAttentionResponse = z.object({ problems: z.array(AttentionProblem).max(50) });
export type GetAttentionResponse = z.infer<typeof GetAttentionResponse>;

export const getAttentionRoute = { method: 'GET', path: '/api/admin/attention' } as const satisfies ApiRoute;
