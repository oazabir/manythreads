import { FileMeta, StoredFile } from '@manythreads/shared';

// The plugin's mapper for `files`: the only place a row becomes a shared entity. `size` is a bigint column (a string from `pg`).

export type FileRow = {
  id: string;
  workspace_id: string;
  team_id: string | null;
  channel_id: string | null;
  folder_path: string;
  name: string;
  blob_key: string;
  size: string | number;
  mime: string;
  sha256: string;
  uploader_id: string;
  created_at: Date;
};

export const FILE_COLUMNS =
  'f.id, f.workspace_id, f.team_id, f.channel_id, f.folder_path, f.name, f.blob_key, f.size, f.mime, f.sha256, f.uploader_id, f.created_at';

export const toStoredFile = (r: FileRow): StoredFile =>
  StoredFile.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    teamId: r.team_id,
    channelId: r.channel_id,
    folderPath: r.folder_path,
    name: r.name,
    blobKey: r.blob_key,
    size: Number(r.size),
    mime: r.mime,
    sha256: r.sha256,
    uploaderId: r.uploader_id,
    createdAt: r.created_at.toISOString(),
  });

/** What the API returns: the stored file without `blobKey`. */
export const toFileMeta = (r: FileRow): FileMeta => FileMeta.parse(toStoredFile(r));
