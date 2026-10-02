import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, FileId, TeamId, WorkspaceId } from '../ids.ts';

// PLAN.md A.3 `files`: attachments in Files storage (principle 8: bytes never go to git). Matches plugins/files/migrations.

/** The most one message may carry. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** The stored row. `blobKey` names the bytes in the storage provider; it never leaves the server (see `FileMeta`). */
export const StoredFile = z.object({
  id: FileId,
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(), // null for a DM or a bot conversation
  channelId: ChannelId.nullable(), // null for a file that belongs to the team itself (Files, phase 4)
  folderPath: z.string().min(1).max(512), // 'channels/<name>/'; 'dms/<channel id>/' for a DM
  name: z.string().min(1).max(255),
  blobKey: z.string().min(1).max(128),
  size: z.number().int().nonnegative(),
  mime: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploaderId: ActorId,
  createdAt: IsoDateTime,
});
export type StoredFile = z.infer<typeof StoredFile>;

/** What the API says about a file: everything but where the bytes are kept. */
export const FileMeta = StoredFile.omit({ blobKey: true });
export type FileMeta = z.infer<typeof FileMeta>;

/** Enough to draw an attachment card on a message (the message carries ids; `ChannelMessage.attachments` resolves them). */
export const FileSummary = StoredFile.pick({ id: true, name: true, size: true, mime: true });
export type FileSummary = z.infer<typeof FileSummary>;
