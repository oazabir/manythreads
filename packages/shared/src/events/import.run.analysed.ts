import { z } from 'zod';
import { ImportSource } from '../api/import/index.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, WorkspaceId } from '../ids.ts';

/**
 * The dry run of an import finished (PLAN P14-13): the archive was read and nothing was written but this report. The counts say how big the archive
 * is; they are numbers only, with no name of a person, channel or file. `ok` is false when the archive could not be read at all.
 */
export const ImportRunAnalysedEvent = z.object({
  type: z.literal('import.run.analysed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runId: z.uuid(),
  source: ImportSource,
  requestedBy: ActorId,
  ok: z.boolean(),
  people: z.number().int().nonnegative(),
  channels: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  at: IsoDateTime,
});
export type ImportRunAnalysedEvent = z.infer<typeof ImportRunAnalysedEvent>;
