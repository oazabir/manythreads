import { z } from 'zod';
import { SpaceRef } from '../entities/space.ts';
import { ActorId, ChannelId, FileId, TeamId, WorkspaceId } from '../ids.ts';

/** A file was stored in a channel's folder. Carries ids and the file's own facts, never bytes. */
export const FilesFileUploadedEvent = z.object({
  type: z.literal('files.file.uploaded'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId.nullable(),
  teamId: TeamId.nullable(),
  fileId: FileId,
  uploaderId: ActorId,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  /** `person:<id>` for a file of a Personal space; then `channelId` and `teamId` are null and `name` is empty (a Personal file's name is private). Absent for a channel file. */
  space: SpaceRef.optional(),
});
export type FilesFileUploadedEvent = z.infer<typeof FilesFileUploadedEvent>;
