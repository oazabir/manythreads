import { z } from 'zod';
import { FileMeta } from '../../entities/file.ts';
import { Page } from '../../common/page.ts';
import { ChannelId, FileId } from '../../ids.ts';

// Uploads are a raw byte stream, not JSON: the body is the file, `x-file-name` (percent-encoded UTF-8) or `?name=` its name, `content-type`
// its type (sniffed again on the server). There is no request schema for the body; the query is `UploadFileQuery`.

export const ChannelFilesPathParams = z.object({ channelId: ChannelId });
export type ChannelFilesPathParams = z.infer<typeof ChannelFilesPathParams>;

export const UploadFileQuery = z.object({ name: z.string().min(1).max(1024).optional() });
export type UploadFileQuery = z.infer<typeof UploadFileQuery>;

/** 201. The server may have renamed the file (`report (2).pdf` when the channel already holds `report.pdf`, unsafe characters replaced). */
export const UploadFileResponse = FileMeta;
export type UploadFileResponse = z.infer<typeof UploadFileResponse>;
export const uploadFileRoute = { method: 'POST', path: '/api/channels/:channelId/files' } as const;

export const ListChannelFilesQuery = z.object({
  before: FileId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListChannelFilesQuery = z.infer<typeof ListChannelFilesQuery>;
export const ListChannelFilesResponse = Page(FileMeta);
export type ListChannelFilesResponse = z.infer<typeof ListChannelFilesResponse>;
export const listChannelFilesRoute = { method: 'GET', path: '/api/channels/:channelId/files' } as const;

export const FilePathParams = z.object({ fileId: FileId });
export type FilePathParams = z.infer<typeof FilePathParams>;

export const GetFileResponse = FileMeta;
export type GetFileResponse = z.infer<typeof GetFileResponse>;
export const getFileRoute = { method: 'GET', path: '/api/files/:fileId' } as const;

/** The bytes (no JSON schema): `content-type` from the stored type, `attachment` unless a safe image, `x-content-type-options: nosniff`. */
export const downloadFileRoute = { method: 'GET', path: '/api/files/:fileId/content' } as const;

/** The uploader or a lead of the channel's team; a file the caller cannot see (or that is already gone) is 403 like any hidden thing. */
export const DeleteFileResponse = z.object({ deleted: z.boolean() });
export type DeleteFileResponse = z.infer<typeof DeleteFileResponse>;
export const deleteFileRoute = { method: 'DELETE', path: '/api/files/:fileId' } as const;
