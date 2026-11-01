import { z } from 'zod';
import { ImportSource } from '../api/import/index.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * An import ended (PLAN P14-13): it finished, failed or was cancelled. Counts only: how many channels and messages it wrote, how many people were
 * matched and how many became placeholders, how many entries it left out. The job writes the event as the system; `startedBy` is the admin who started it.
 */
export const ImportRunFinishedEvent = z.object({
  type: z.literal('import.run.finished'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runId: z.uuid(),
  source: ImportSource,
  teamId: TeamId,
  startedBy: ActorId,
  outcome: z.enum(['done', 'failed', 'cancelled']),
  channels: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  matchedPeople: z.number().int().nonnegative(),
  placeholders: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  at: IsoDateTime,
});
export type ImportRunFinishedEvent = z.infer<typeof ImportRunFinishedEvent>;
