import { z } from 'zod';
import { ImportSource } from '../api/import/index.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A workspace admin uploaded an export from Slack or Mattermost to import (PLAN P14-13). The event names the run, the source, the team the channels
 * would be made in and the size; never the file's name (an admin may have called it anything) and nothing from inside the archive.
 */
export const ImportRunUploadedEvent = z.object({
  type: z.literal('import.run.uploaded'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  runId: z.uuid(),
  source: ImportSource,
  teamId: TeamId,
  size: z.number().int().nonnegative(),
  uploadedBy: ActorId,
  at: IsoDateTime,
});
export type ImportRunUploadedEvent = z.infer<typeof ImportRunUploadedEvent>;
