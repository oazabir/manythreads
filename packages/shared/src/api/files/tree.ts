import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { GitSha } from '../../entities/repo.ts';
import { RepoFolderPath } from '../repo/repo.ts';
import { ActorId, ChannelId, FileId } from '../../ids.ts';

// The Files tree (SPEC section 5.2, PLAN P4-06): one listing over the team repo (git) and the attachments of channels (`channels/<name>/`, Files
// storage). Both stores answer with the same row, so a client draws one list and never asks which store a row came from (it may, for the actions
// each store allows: `source`, `readOnly`).

export const FilesTreeEntryKind = z.enum(['file', 'folder']);
export type FilesTreeEntryKind = z.infer<typeof FilesTreeEntryKind>;

/** `repo` is git (text: pages, config), `attachment` is Files storage (the bytes of channel uploads). */
export const FilesTreeSource = z.enum(['repo', 'attachment']);
export type FilesTreeSource = z.infer<typeof FilesTreeSource>;

/**
 * Why a row cannot be edited by the caller here. `change_by_pull_request`: `bots/`, `TEAM.md`, `skills/`, `routines/` for a member who is not a lead or
 * admin (the UI offers a pull request, a direct write is 403). `attachment`: an uploaded file never changes in place (replace it by uploading again).
 * `no_write_access`: the caller may read but not post in the team.
 */
export const FilesReadOnlyReason = z.enum(['change_by_pull_request', 'attachment', 'no_write_access']);
export type FilesReadOnlyReason = z.infer<typeof FilesReadOnlyReason>;

/** Who maintains a folder besides people: `team_memory` is `memory/` (the journal is written by the team's memory; facts may be edited by hand). */
export const FilesManagedBy = z.enum(['team_memory']);
export type FilesManagedBy = z.infer<typeof FilesManagedBy>;

/** One row of the tree. The shape is identical for every store; fields that do not apply are null. */
export const FilesTreeEntry = z.object({
  kind: FilesTreeEntryKind,
  /** The full path from the root of the tree: `pages/reports/week-37.md`, `channels/dev/spec.pdf`. No trailing slash on folders. */
  path: z.string().min(1),
  name: z.string().min(1),
  /** Bytes; null for a folder. */
  size: z.number().int().nonnegative().nullable(),
  /** The type to open it with (from the bytes for an attachment, from the extension for a repo file); null for a folder. */
  mime: z.string().nullable(),
  /** The last change (a folder: the newest change below it). Null when unknown (an empty folder, a folder made of other folders). */
  updatedAt: IsoDateTime.nullable(),
  /** The actor of that change: the commit author, or the uploader. Null for a system commit. */
  updatedBy: ActorId.nullable(),
  source: FilesTreeSource,
  readOnly: z.boolean(),
  readOnlyReason: FilesReadOnlyReason.nullable(),
  managedBy: FilesManagedBy.nullable(),
  /** Attachment rows: the file id (`GET /api/files/:id`) and the channel it belongs to. */
  fileId: FileId.nullable(),
  channelId: ChannelId.nullable(),
  /** Repo files: the blob sha, to send back as `baseBlobSha` when saving. */
  blobSha: GitSha.nullable(),
  /** Where the bytes are: `GET /api/files/:id/content` or `GET /api/teams/:slug/repo/content?path=`. Null for a folder. Works as an `<img src>`. */
  contentUrl: z.string().nullable(),
});
export type FilesTreeEntry = z.infer<typeof FilesTreeEntry>;

/** What is true of the folder being listed (the breadcrumb's last step). */
export const FilesTreeFolder = z.object({
  path: z.string(),
  source: FilesTreeSource,
  readOnly: z.boolean(),
  readOnlyReason: FilesReadOnlyReason.nullable(),
  managedBy: FilesManagedBy.nullable(),
  /** The channel behind `channels/<name>`; null elsewhere. */
  channelId: ChannelId.nullable(),
});
export type FilesTreeFolder = z.infer<typeof FilesTreeFolder>;

export const FilesTreePathParams = z.object({ slug: z.string().min(1).max(63) });
export type FilesTreePathParams = z.infer<typeof FilesTreePathParams>;

export const MAX_FILES_TREE_ENTRIES = 2000;

export const GetFilesTreeQuery = z.object({
  /** The folder; empty is the root. */
  path: RepoFolderPath.default(''),
  /** At most this many rows (default 500). A longer folder answers `truncated: true`. */
  limit: z.coerce.number().int().min(1).max(MAX_FILES_TREE_ENTRIES).default(500),
});
export type GetFilesTreeQuery = z.infer<typeof GetFilesTreeQuery>;

/**
 * Folders first, then files, each by name. The root holds the repo's folders and files and the folder `channels` (one folder per channel the caller
 * can read). 403: the team, or the channel behind `channels/<name>`, is not the caller's to read (a guest without a grant, a member of another team).
 */
export const GetFilesTreeResponse = z.object({
  path: z.string(),
  folder: FilesTreeFolder,
  entries: z.array(FilesTreeEntry),
  truncated: z.boolean(),
});
export type GetFilesTreeResponse = z.infer<typeof GetFilesTreeResponse>;
export const getFilesTreeRoute = { method: 'GET', path: '/api/teams/:slug/files/tree' } as const;
