import { z } from 'zod';
import { SpaceRef } from '../entities/space.ts';
import { ActorId, FileId, FileVersionId, WorkspaceId } from '../ids.ts';

/**
 * An older version of a Personal file became its current content (the current content was kept as a version). Ids only: no name, no bytes, no
 * path, because a Personal space is private and the event log is not.
 */
export const FilesFileRestoredEvent = z.object({
  type: z.literal('files.file.restored'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  fileId: FileId,
  versionId: FileVersionId,
  space: SpaceRef,
  restoredBy: ActorId,
});
export type FilesFileRestoredEvent = z.infer<typeof FilesFileRestoredEvent>;
