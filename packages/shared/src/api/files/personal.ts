import { z } from 'zod';
import { Page } from '../../common/page.ts';
import { IsoDateTime } from '../../common/time.ts';
import { SpaceRef } from '../../entities/space.ts';
import { ActorId, FileId, FileVersionId, PersonId } from '../../ids.ts';
import { RepoFilePath, RepoFolderPath } from '../repo/repo.ts';
import { GetFilesTreeResponse } from './tree.ts';
import type { ApiRoute } from '../client/route.ts';

// P20-02 / P20-13 / P20-14: a person's Personal files. A Personal space is where one person keeps their own files (Notes, Meetings, Inbox, Memory,
// Knowledge, Routines, Action items, and any folder they add); only that person reads it, plus a workspace owner or admin for the 60 minutes after
// an audited "open" (kernel 0016, `app.personal_space_access`). Bytes live in Files storage, rows in `app.files` with `owner_person_id`.
// Paths on the wire have no leading and no trailing slash: `Notes`, `Notes/2026`, `Notes/2026/todo.md`. A file always lives inside a folder.
// The bytes of any file (a person's own, an admin's open, an old version) are read from `GET /api/files/:fileId/content` (the database decides who may)
// or `GET /api/me/files/:fileId/versions/:versionId/content`.

/** The folders every Personal space starts with. Created the first time the tree is read; none can be removed. */
export const PERSONAL_SEED_FOLDERS = ['Notes', 'Meetings', 'Inbox', 'Memory', 'Knowledge', 'Routines', 'Action items'] as const;
export type PersonalSeedFolder = (typeof PERSONAL_SEED_FOLDERS)[number];

/** Each person's allowance over live files and every version kept (5 GiB). `MANYTHREADS_PERSONAL_QUOTA_BYTES` replaces it on a deployment. */
export const DEFAULT_PERSONAL_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
/** Versions of one file kept: the newest 50, and any younger than 90 days, whichever is more. */
export const PERSONAL_VERSIONS_KEEP = 50;
export const PERSONAL_VERSIONS_KEEP_DAYS = 90;
/** An admin's open of a Personal space lasts this long. */
export const PERSONAL_OPEN_MINUTES = 60;
/** The leaver's Personal space is deleted this many days after the person was deactivated (`retention_settings.personal_keep_days`). */
export const PERSONAL_KEEP_DAYS_DEFAULT = 30;

/**
 * A folder of a Personal space: not empty, at most 500 characters, and none of the characters that make one name look like another (the right-to-left
 * and other direction overrides, zero-width marks, the line and paragraph separators, the byte-order mark) or that a terminal or an unzip tool would act
 * on (the C1 control characters). A file name loses the same characters (`sanitizeFileName`), so a zip of the space never lists a spoofed name.
 */
const SPOOFING_CHARACTER = /[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/u;
export const PersonalFolderPath = RepoFolderPath.refine((v) => v !== '' && v.length <= 500 && !SPOOFING_CHARACTER.test(v), { message: 'Name a folder.' });
export type PersonalFolderPath = z.infer<typeof PersonalFolderPath>;

export const PersonalFile = z.object({
  id: FileId,
  ownerPersonId: PersonId,
  /** `person:<id>`. */
  space: SpaceRef,
  /** The folder, no trailing slash: `Notes`. */
  folderPath: z.string(),
  name: z.string().min(1).max(255),
  /** `folderPath/name`. */
  path: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: IsoDateTime,
  /** The last time the content or the place changed. */
  updatedAt: IsoDateTime,
  updatedBy: ActorId.nullable(),
  /** Older versions kept (not counting the current one). */
  versionCount: z.number().int().nonnegative(),
  /** `GET /api/files/:id/content`. */
  contentUrl: z.string(),
});
export type PersonalFile = z.infer<typeof PersonalFile>;

// ---- tree ------------------------------------------------------------------------------------------------------------------------------

/**
 * The folder listing of the caller's own Personal space. The answer is the same `GetFilesTreeResponse` the team tree gives (`source: 'attachment'`,
 * `fileId` set, `channelId` null), so one list component draws both. The root lists the folders only. `Memory` has `managedBy: 'personal_memory'`.
 * A folder the caller never made is 404; a guest gets 403 on everything under `/api/me/files` (a guest has no Personal space).
 */
export const getMyFilesTreeRoute = { method: 'GET', path: '/api/me/files/tree' } as const satisfies ApiRoute;

/** An admin's read-only view of someone's space during a live open. 403 `forbidden` (with "open this Personal space first") when there is none. */
export const PersonFilesTreePathParams = z.object({ personId: PersonId });
export type PersonFilesTreePathParams = z.infer<typeof PersonFilesTreePathParams>;
export const getPersonFilesTreeRoute = { method: 'GET', path: '/api/people/:personId/files/tree' } as const satisfies ApiRoute;

// ---- upload / change / delete ----------------------------------------------------------------------------------------------------------

/**
 * The upload is a raw byte stream like a channel upload: body = the file, `x-file-name` (percent-encoded) or `?name=` its name, `content-type` its type
 * (sniffed again on the server). `conflict`: when the folder already holds that name, `rename` (default) stores `report (2).pdf`; `version` keeps the
 * old content as a version and replaces it (how a note is saved). 413 when the file is over the upload limit or the person over their allowance.
 */
export const UploadPersonalFileQuery = z.object({
  folderPath: PersonalFolderPath,
  name: z.string().min(1).max(1024).optional(),
  conflict: z.enum(['rename', 'version']).default('rename'),
});
export type UploadPersonalFileQuery = z.infer<typeof UploadPersonalFileQuery>;
export const UploadPersonalFileResponse = PersonalFile;
export type UploadPersonalFileResponse = z.infer<typeof UploadPersonalFileResponse>;
export const uploadPersonalFileRoute = { method: 'POST', path: '/api/me/files' } as const satisfies ApiRoute;

export const PersonalFilePathParams = z.object({ fileId: FileId });
export type PersonalFilePathParams = z.infer<typeof PersonalFilePathParams>;

/** Rename and/or move. 409 when the target folder already holds that name. */
export const UpdatePersonalFileRequest = z
  .strictObject({
    name: z.string().trim().min(1).max(255).optional(),
    folderPath: PersonalFolderPath.optional(),
  })
  .refine((v) => v.name !== undefined || v.folderPath !== undefined, { message: 'Change the name or the folder.' });
export type UpdatePersonalFileRequest = z.infer<typeof UpdatePersonalFileRequest>;
export const UpdatePersonalFileResponse = PersonalFile;
export type UpdatePersonalFileResponse = z.infer<typeof UpdatePersonalFileResponse>;
export const updatePersonalFileRoute = { method: 'PATCH', path: '/api/me/files/:fileId' } as const satisfies ApiRoute;

/** Removes the file with all its versions and frees the space at once. */
export const DeletePersonalFileResponse = z.object({ deleted: z.boolean() });
export type DeletePersonalFileResponse = z.infer<typeof DeletePersonalFileResponse>;
export const deletePersonalFileRoute = { method: 'DELETE', path: '/api/me/files/:fileId' } as const satisfies ApiRoute;

/** A new empty folder (any depth; parents are made too). The seed folders exist already; naming one again answers the same 200. */
export const CreatePersonalFolderRequest = z.strictObject({ path: PersonalFolderPath });
export type CreatePersonalFolderRequest = z.infer<typeof CreatePersonalFolderRequest>;
export const CreatePersonalFolderResponse = z.object({ path: z.string() });
export type CreatePersonalFolderResponse = z.infer<typeof CreatePersonalFolderResponse>;
export const createPersonalFolderRoute = { method: 'POST', path: '/api/me/files/folders' } as const satisfies ApiRoute;

/** Removes a folder that holds nothing (no file, no subfolder). 409 when it does; a seed folder cannot be removed (409). */
export const DeletePersonalFolderQuery = z.object({ path: PersonalFolderPath });
export type DeletePersonalFolderQuery = z.infer<typeof DeletePersonalFolderQuery>;
export const DeletePersonalFolderResponse = z.object({ deleted: z.boolean() });
export type DeletePersonalFolderResponse = z.infer<typeof DeletePersonalFolderResponse>;
export const deletePersonalFolderRoute = { method: 'DELETE', path: '/api/me/files/folders' } as const satisfies ApiRoute;

// ---- versions --------------------------------------------------------------------------------------------------------------------------

/** One version. The first item of the list is the current content (`current: true`, `id` null); the others are the kept older contents, newest first. */
export const PersonalFileVersion = z.object({
  id: FileVersionId.nullable(),
  current: z.boolean(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Who stored this content. */
  authorId: ActorId.nullable(),
  /** When this content was stored. */
  createdAt: IsoDateTime,
  /** Where the bytes are. Works as a link. */
  contentUrl: z.string(),
});
export type PersonalFileVersion = z.infer<typeof PersonalFileVersion>;
export const ListPersonalFileVersionsResponse = z.object({ items: z.array(PersonalFileVersion) });
export type ListPersonalFileVersionsResponse = z.infer<typeof ListPersonalFileVersionsResponse>;
export const listPersonalFileVersionsRoute = { method: 'GET', path: '/api/me/files/:fileId/versions' } as const satisfies ApiRoute;

export const PersonalFileVersionPathParams = z.object({ fileId: FileId, versionId: FileVersionId });
export type PersonalFileVersionPathParams = z.infer<typeof PersonalFileVersionPathParams>;
/** The bytes of one older version (no JSON schema; same headers as a file download). */
export const downloadPersonalFileVersionRoute = { method: 'GET', path: '/api/me/files/:fileId/versions/:versionId/content' } as const satisfies ApiRoute;

/** Makes an older version the current content. The current content becomes a version itself, so a restore never loses anything. No body. */
export const RestorePersonalFileVersionResponse = PersonalFile;
export type RestorePersonalFileVersionResponse = z.infer<typeof RestorePersonalFileVersionResponse>;
export const restorePersonalFileVersionRoute = { method: 'POST', path: '/api/me/files/:fileId/versions/:versionId/restore' } as const satisfies ApiRoute;

// ---- allowance -------------------------------------------------------------------------------------------------------------------------

export const PersonalFilesUsage = z.object({
  /** Live files plus every kept version. */
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
  fileCount: z.number().int().nonnegative(),
});
export type PersonalFilesUsage = z.infer<typeof PersonalFilesUsage>;
export const getPersonalFilesUsageRoute = { method: 'GET', path: '/api/me/files/usage' } as const satisfies ApiRoute;

// ---- sharing out of Personal (P20-14) --------------------------------------------------------------------------------------------------

/** Where a Personal file may be sent: a text file into a team's files (the team repo), or a file into a team's memory inbox. */
export const PersonalShareDestination = z.enum(['team_files', 'team_inbox']);
export type PersonalShareDestination = z.infer<typeof PersonalShareDestination>;

/**
 * Asks the workspace's data rules (the same chain the model gateway uses) what they say about sending this file to a team, without sending it. For the
 * dialog's warning; the copy route below asks again and enforces. `rules` are rule names, never the matched text. `allow`: nothing found. `redact`:
 * the copy would have the matches replaced. `require_approval` and `block`: the copy is refused.
 */
export const PersonalShareCheckRequest = z.strictObject({ destination: PersonalShareDestination, teamSlug: z.string().min(1).max(63) });
export type PersonalShareCheckRequest = z.infer<typeof PersonalShareCheckRequest>;
export const PersonalShareCheckResponse = z.object({
  outcome: z.enum(['allow', 'redact', 'require_approval', 'block']),
  rules: z.array(z.string()),
});
export type PersonalShareCheckResponse = z.infer<typeof PersonalShareCheckResponse>;
export const personalShareCheckRoute = { method: 'POST', path: '/api/me/files/:fileId/share-check' } as const satisfies ApiRoute;

/**
 * Copies a text Personal file (UTF-8, at most 1 MB) into a team's files: a commit to the team repo at `path` by the caller, who needs the right to write
 * there. The data rules run first; `block` and `require_approval` answer 409 `conflict`, `redact` commits the redacted text and says so. 409 when
 * `path` exists, 422 `attachment_not_in_repo` for a file that is not text. The Personal original stays.
 */
export const CopyPersonalFileToTeamRequest = z.strictObject({ teamSlug: z.string().min(1).max(63), path: RepoFilePath });
export type CopyPersonalFileToTeamRequest = z.infer<typeof CopyPersonalFileToTeamRequest>;
export const CopyPersonalFileToTeamResponse = z.object({ path: z.string(), commitSha: z.string(), redacted: z.boolean() });
export type CopyPersonalFileToTeamResponse = z.infer<typeof CopyPersonalFileToTeamResponse>;
export const copyPersonalFileToTeamRoute = { method: 'POST', path: '/api/me/files/:fileId/copy-to-team' } as const satisfies ApiRoute;

// ---- admin open, export, and the person's own list of opens (P20-13) -----------------------------------------------------------------

export const PersonalSpacePathParams = z.object({ personId: PersonId });
export type PersonalSpacePathParams = z.infer<typeof PersonalSpacePathParams>;

/** A workspace owner or admin opens another person's Personal space for 60 minutes. The reason (1 to 300 characters) is shown to that person and kept nowhere else. */
export const OpenPersonalSpaceRequest = z.strictObject({ reason: z.string().trim().min(1, 'Give a reason.').max(300, 'Keep the reason under 300 characters.') });
export type OpenPersonalSpaceRequest = z.infer<typeof OpenPersonalSpaceRequest>;
export const OpenPersonalSpaceResponse = z.object({ accessId: z.uuid(), validUntil: IsoDateTime });
export type OpenPersonalSpaceResponse = z.infer<typeof OpenPersonalSpaceResponse>;
/** 403 for a non-admin, 400 for your own space or a missing reason, 404 for a person who is not in this workspace. */
export const openPersonalSpaceRoute = { method: 'POST', path: '/api/people/:personId/personal-space/open' } as const satisfies ApiRoute;

/** The admin view of a space: the same tree as the person's own, read-only (`readOnlyReason: 'admin_view'` on every row), plus when the open lapses. */
export const PersonFilesTreeResponse = GetFilesTreeResponse.extend({ validUntil: IsoDateTime, displayName: z.string() });
export type PersonFilesTreeResponse = z.infer<typeof PersonFilesTreeResponse>;

/** Everything the person keeps, as one zip (folders as in the tree, each file's current content). Needs a live open; the download is audited. No body. */
export const exportPersonalSpaceRoute = { method: 'POST', path: '/api/people/:personId/personal-space/export' } as const satisfies ApiRoute;

/** The person's own list of who opened their Personal space and why, newest first. `active`: the open has not lapsed yet. */
export const PersonalSpaceOpen = z.object({
  id: z.uuid(),
  adminPersonId: PersonId.nullable(),
  adminName: z.string(),
  reason: z.string(),
  openedAt: IsoDateTime,
  validUntil: IsoDateTime,
  active: z.boolean(),
});
export type PersonalSpaceOpen = z.infer<typeof PersonalSpaceOpen>;
export const ListPersonalSpaceOpensQuery = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListPersonalSpaceOpensQuery = z.infer<typeof ListPersonalSpaceOpensQuery>;
export const ListPersonalSpaceOpensResponse = Page(PersonalSpaceOpen);
export type ListPersonalSpaceOpensResponse = z.infer<typeof ListPersonalSpaceOpensResponse>;
export const listPersonalSpaceOpensRoute = { method: 'GET', path: '/api/me/personal-space/opens' } as const satisfies ApiRoute;
