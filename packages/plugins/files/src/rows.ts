import { FileMeta, PersonalFile, spaceRefOf, StoredFile } from '@manythreads/shared';

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
  /** Personal files (files 0005): the owner, and the last change of content or place. */
  owner_person_id?: string | null;
  updated_at?: Date | null;
  updated_by?: string | null;
};

export const FILE_COLUMNS =
  'f.id, f.workspace_id, f.team_id, f.channel_id, f.folder_path, f.name, f.blob_key, f.size, f.mime, f.sha256, f.uploader_id, f.created_at, f.owner_person_id, f.updated_at, f.updated_by';

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

/** A Personal file row with the number of older versions it keeps. */
export type PersonalFileRow = FileRow & { owner_person_id: string; version_count: number };

/** The columns of a file and its version count, for the Personal routes. */
export const PERSONAL_FILE_COLUMNS = `${FILE_COLUMNS}, (SELECT count(*)::int FROM app.file_versions v WHERE v.file_id = f.id) AS version_count`;

/** A folder in the database ends with a slash (`Notes/`); on the wire it does not (`Notes`). */
export const wireFolder = (dbFolder: string): string => dbFolder.replace(/\/$/, '');
export const dbFolder = (wire: string): string => `${wire}/`;

export const toPersonalFile = (r: PersonalFileRow): PersonalFile => {
  const folderPath = wireFolder(r.folder_path);
  return PersonalFile.parse({
    id: r.id,
    ownerPersonId: r.owner_person_id,
    space: spaceRefOf({ kind: 'person', personId: r.owner_person_id as never }),
    folderPath,
    name: r.name,
    path: `${folderPath}/${r.name}`,
    size: Number(r.size),
    mime: r.mime,
    sha256: r.sha256,
    createdAt: r.created_at.toISOString(),
    updatedAt: (r.updated_at ?? r.created_at).toISOString(),
    updatedBy: r.updated_by ?? r.uploader_id,
    versionCount: r.version_count,
    contentUrl: `/api/files/${r.id}/content`,
  });
};
