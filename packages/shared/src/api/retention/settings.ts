import { z } from 'zod';
import { RETENTION_MEMORY_LOG_DAYS, RETENTION_RUN_LOG_DAYS, RetentionSettings } from '../../entities/retention.ts';
import type { ApiRoute } from '../client/route.ts';

// Workspace → Retention (PLAN P5-14). Workspace admins only: how long run logs are kept is a workspace-wide policy. The deployment's mode
// (`MANYTHREADS_RETENTION`) decides whether anything is deleted at all; the settings here only choose the window.

/** Change the windows; at least one field is required. A value outside the bounds is refused, never clamped. */
export const SetRetentionSettingsRequest = z
  .strictObject({
    runLogDays: z.number().int().min(RETENTION_RUN_LOG_DAYS.min).max(RETENTION_RUN_LOG_DAYS.max).optional(),
    memoryLogDays: z.number().int().min(RETENTION_MEMORY_LOG_DAYS.min).max(RETENTION_MEMORY_LOG_DAYS.max).optional(),
  })
  .refine((v) => v.runLogDays !== undefined || v.memoryLogDays !== undefined, { message: 'Change at least one field.' });
export type SetRetentionSettingsRequest = z.infer<typeof SetRetentionSettingsRequest>;

export const RetentionSettingsResponse = z.object({ settings: RetentionSettings });
export type RetentionSettingsResponse = z.infer<typeof RetentionSettingsResponse>;

/** Queues a dry run for this workspace (counts only, whatever the deployment's mode is); its result appears as `lastSweep`. */
export const PreviewRetentionResponse = z.object({ queued: z.literal(true) });
export type PreviewRetentionResponse = z.infer<typeof PreviewRetentionResponse>;

export const getRetentionSettingsRoute = { method: 'GET', path: '/api/workspace/retention' } as const satisfies ApiRoute;
export const setRetentionSettingsRoute = { method: 'PUT', path: '/api/workspace/retention' } as const satisfies ApiRoute;
export const previewRetentionRoute = { method: 'POST', path: '/api/workspace/retention/preview' } as const satisfies ApiRoute;
