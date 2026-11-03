import { z } from 'zod';
import { ShareRun, ShareRunId, ShareSlug, ShareView, SharePreview, ShareDestination } from '../../entities/share.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// The routes of a team's outgoing memory shares (PLAN P8-22, P8-23). Anyone who can read the team lists its shares; a lead or a workspace admin previews a share,
// runs it now, and reads its runs (the runs name what was left out). docs/plugins/memory-share.md.

export const ShareTeamParams = z.object({ slug: TeamSlug });
export type ShareTeamParams = z.infer<typeof ShareTeamParams>;
export const ShareParams = z.object({ slug: TeamSlug, shareSlug: ShareSlug });
export type ShareParams = z.infer<typeof ShareParams>;
export const ShareRunParams = z.object({ slug: TeamSlug, shareSlug: ShareSlug, runId: ShareRunId });
export type ShareRunParams = z.infer<typeof ShareRunParams>;

export const ListSharesResponse = z.object({
  shares: z.array(ShareView),
  /** Whether the signed-in person may preview, run and read the runs (a team lead or a workspace admin). */
  canManage: z.boolean(),
});
export type ListSharesResponse = z.infer<typeof ListSharesResponse>;
export const listSharesRoute = { method: 'GET', path: '/api/teams/:slug/shares' } as const satisfies ApiRoute;

export const GetShareResponse = z.object({ share: ShareView, canManage: z.boolean(), destinations: z.array(ShareDestination) });
export type GetShareResponse = z.infer<typeof GetShareResponse>;
export const getShareRoute = { method: 'GET', path: '/api/teams/:slug/shares/:shareSlug' } as const satisfies ApiRoute;

export const PreviewShareResponse = z.object({ preview: SharePreview });
export type PreviewShareResponse = z.infer<typeof PreviewShareResponse>;
export const previewShareRoute = { method: 'GET', path: '/api/teams/:slug/shares/:shareSlug/preview' } as const satisfies ApiRoute;

/** Run now: starts building a digest. The answer is the run in state `building`; read it again (or the runs list) to see where it ends. */
export const RunShareResponse = z.object({ run: ShareRun });
export type RunShareResponse = z.infer<typeof RunShareResponse>;
export const runShareRoute = { method: 'POST', path: '/api/teams/:slug/shares/:shareSlug/run' } as const satisfies ApiRoute;

export const ListShareRunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
export type ListShareRunsQuery = z.infer<typeof ListShareRunsQuery>;
export const ListShareRunsResponse = z.object({ runs: z.array(ShareRun) });
export type ListShareRunsResponse = z.infer<typeof ListShareRunsResponse>;
export const listShareRunsRoute = { method: 'GET', path: '/api/teams/:slug/shares/:shareSlug/runs' } as const satisfies ApiRoute;

export const GetShareRunResponse = z.object({ run: ShareRun });
export type GetShareRunResponse = z.infer<typeof GetShareRunResponse>;
export const getShareRunRoute = { method: 'GET', path: '/api/teams/:slug/shares/:shareSlug/runs/:runId' } as const satisfies ApiRoute;
