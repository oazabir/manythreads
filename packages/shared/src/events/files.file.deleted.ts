import { z } from 'zod';
import { ActorId, ChannelId, FileId, TeamId, WorkspaceId } from '../ids.ts';

/** A file row and its bytes were removed by its uploader or a lead of the channel's team. */
export const FilesFileDeletedEvent = z.object({
  type: z.literal('files.file.deleted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  channelId: ChannelId.nullable(),
  teamId: TeamId.nullable(),
  fileId: FileId,
  deletedBy: ActorId,
});
export type FilesFileDeletedEvent = z.infer<typeof FilesFileDeletedEvent>;
