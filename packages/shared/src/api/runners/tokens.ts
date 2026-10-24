import { z } from 'zod';
import { RunnerId } from '../../ids.ts';
import { IsoDateTime } from '../../common/time.ts';
import { TeamSlug } from '../teams/common.ts';

// A runner's credential (PLAN P6-06). A team lead (or a workspace admin) mints a token for a runner they registered; the program that runs
// on the machine presents it as `Authorization: Bearer <token>` when it connects. The database keeps only the token's sha256, the token
// is shown once, and revoking turns every live token of that runner off (an open connection ends within a minute).

/** What every runner token starts with, so a leaked one is recognisable by a secret scanner. */
export const RUNNER_TOKEN_PREFIX = 'mtr_';

export const RunnerTokenPathParams = z.object({ slug: TeamSlug, runnerId: RunnerId });
export type RunnerTokenPathParams = z.infer<typeof RunnerTokenPathParams>;

export const MintRunnerTokenResponse = z.object({
  runnerId: RunnerId,
  /** Shown once: only its hash is kept. */
  token: z.string().startsWith(RUNNER_TOKEN_PREFIX),
  createdAt: IsoDateTime,
});
export type MintRunnerTokenResponse = z.infer<typeof MintRunnerTokenResponse>;
export const mintRunnerTokenRoute = { method: 'POST', path: '/api/teams/:slug/runners/:runnerId/token' } as const;

export const RevokeRunnerTokensResponse = z.object({ revoked: z.number().int().min(0) });
export type RevokeRunnerTokensResponse = z.infer<typeof RevokeRunnerTokensResponse>;
export const revokeRunnerTokensRoute = { method: 'DELETE', path: '/api/teams/:slug/runners/:runnerId/token' } as const;

/** The WebSocket route a runner connects to (bearer runner token in the upgrade request). */
export const runnerConnectRoute = { method: 'GET', path: '/api/runners/connect' } as const;
