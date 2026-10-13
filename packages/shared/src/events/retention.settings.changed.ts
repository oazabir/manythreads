import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/**
 * A workspace admin changed how long run logs are kept (PLAN P5-14). Retention deletes data, so a change of its window is an audited act:
 * who, when, from what to what.
 */
export const RetentionSettingsChangedEvent = z.object({
  type: z.literal('retention.settings.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  changedBy: ActorId,
  runLogDays: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }),
  memoryLogDays: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }),
  changedAt: IsoDateTime,
});
export type RetentionSettingsChangedEvent = z.infer<typeof RetentionSettingsChangedEvent>;
