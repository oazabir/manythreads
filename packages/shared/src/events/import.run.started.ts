import { z } from 'zod';
import { ImportSource } from '../api/import/index.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** A workspace admin started an import after reading its dry-run report (PLAN P14-13). Who, which run, where the channels go; nothing from the archive. */
export const ImportRunStartedEvent = z.object({
  type: z.literal('import.run.started'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runId: z.uuid(),
  source: ImportSource,
  teamId: TeamId,
  startedBy: ActorId,
  at: IsoDateTime,
});
export type ImportRunStartedEvent = z.infer<typeof ImportRunStartedEvent>;
