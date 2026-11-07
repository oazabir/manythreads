import {
  CopyPersonalFileToTeamRequest,
  CopyPersonalFileToTeamResponse,
  CreatePersonalFolderRequest,
  CreatePersonalFolderResponse,
  DeletePersonalFileResponse,
  DeletePersonalFolderResponse,
  GetFilesTreeQuery,
  GetFilesTreeResponse,
  ListPersonalFileVersionsResponse,
  ListPersonalSpaceOpensQuery,
  ListPersonalSpaceOpensResponse,
  OpenPersonalSpaceRequest,
  OpenPersonalSpaceResponse,
  PersonFilesTreeResponse,
  PersonalFile,
  PersonalFilesUsage,
  PersonalShareCheckRequest,
  PersonalShareCheckResponse,
  RestorePersonalFileVersionResponse,
  UpdatePersonalFileRequest,
  UpdatePersonalFileResponse,
  copyPersonalFileToTeamRoute,
  createPersonalFolderRoute,
  deletePersonalFileRoute,
  deletePersonalFolderRoute,
  getMyFilesTreeRoute,
  getPersonFilesTreeRoute,
  getPersonalFilesUsageRoute,
  listPersonalFileVersionsRoute,
  exportPersonalSpaceRoute,
  listPersonalSpaceOpensRoute,
  openPersonalSpaceRoute,
  personalShareCheckRoute,
  restorePersonalFileVersionRoute,
  updatePersonalFileRoute,
  uploadPersonalFileRoute,
} from '@manythreads/shared';
import { ApiError, CSRF_HEADER, buildPath, call, readCsrfCookie } from '../../api/client';
import { isMockMode } from '../../api/setup';
import { mockOpenSpace, mockOpens } from './personalMock';

/*
 * The calls behind a person's own files (`/api/me/files/*`) and the admin's open of a Personal space. The shapes are the shared contract
 * (`packages/shared/src/api/files/personal.ts`); this file only sends and parses.
 */

export const fetchMyTree = (path: string, limit?: number) =>
  call(getMyFilesTreeRoute, { request: GetFilesTreeQuery, response: GetFilesTreeResponse }, GetFilesTreeQuery.parse({ path, ...(limit ? { limit } : {}) }));

export const fetchPersonTree = (personId: string, path: string) =>
  call(getPersonFilesTreeRoute, { request: GetFilesTreeQuery, response: PersonFilesTreeResponse }, GetFilesTreeQuery.parse({ path }), { personId });

export const fetchUsage = () => call(getPersonalFilesUsageRoute, { response: PersonalFilesUsage });

export const patchPersonalFile = (fileId: string, body: UpdatePersonalFileRequest) =>
  call(updatePersonalFileRoute, { request: UpdatePersonalFileRequest, response: UpdatePersonalFileResponse }, UpdatePersonalFileRequest.parse(body), { fileId });

export const removePersonalFile = (fileId: string) => call(deletePersonalFileRoute, { response: DeletePersonalFileResponse }, undefined, { fileId });

export const makePersonalFolder = (path: string) =>
  call(createPersonalFolderRoute, { request: CreatePersonalFolderRequest, response: CreatePersonalFolderResponse }, CreatePersonalFolderRequest.parse({ path }));

/** The folder's path is a query on a DELETE, and the shared client sends a body on those, so the query is put on the address here. */
export const removePersonalFolder = (path: string) =>
  call({ ...deletePersonalFolderRoute, path: `${deletePersonalFolderRoute.path}?path=${encodeURIComponent(path)}` }, { response: DeletePersonalFolderResponse });

export const fetchVersions = (fileId: string) => call(listPersonalFileVersionsRoute, { response: ListPersonalFileVersionsResponse }, undefined, { fileId });

export const restoreVersion = (fileId: string, versionId: string) => call(restorePersonalFileVersionRoute, { response: RestorePersonalFileVersionResponse }, undefined, { fileId, versionId });

export const checkShare = (fileId: string, body: PersonalShareCheckRequest) =>
  call(personalShareCheckRoute, { request: PersonalShareCheckRequest, response: PersonalShareCheckResponse }, PersonalShareCheckRequest.parse(body), { fileId });

export const copyToTeam = (fileId: string, body: CopyPersonalFileToTeamRequest) =>
  call(copyPersonalFileToTeamRoute, { request: CopyPersonalFileToTeamRequest, response: CopyPersonalFileToTeamResponse }, CopyPersonalFileToTeamRequest.parse(body), { fileId });

export const openPersonalSpace = (personId: string, reason: string, adminName = 'An admin'): Promise<OpenPersonalSpaceResponse> =>
  isMockMode()
    ? Promise.resolve(mockOpenSpace(adminName, OpenPersonalSpaceRequest.parse({ reason }).reason))
    : call(openPersonalSpaceRoute, { request: OpenPersonalSpaceRequest, response: OpenPersonalSpaceResponse }, OpenPersonalSpaceRequest.parse({ reason }), { personId });

export const fetchOpens = (query: Partial<ListPersonalSpaceOpensQuery> = {}): Promise<ListPersonalSpaceOpensResponse> =>
  isMockMode()
    ? Promise.resolve({ items: mockOpens(), nextCursor: null } as ListPersonalSpaceOpensResponse)
    : call(listPersonalSpaceOpensRoute, { request: ListPersonalSpaceOpensQuery, response: ListPersonalSpaceOpensResponse }, ListPersonalSpaceOpensQuery.parse(query));

/** The whole space as one zip (needs a live open). Returns the bytes; the caller saves them. */
export async function exportPersonalSpace(personId: string): Promise<Blob> {
  if (isMockMode()) return new Blob(['Personal space export (sample)'], { type: 'application/zip' });
  const csrf = readCsrfCookie(document.cookie);
  const res = await fetch(buildPath(exportPersonalSpaceRoute.path, { personId }), { method: exportPersonalSpaceRoute.method, credentials: 'same-origin', headers: csrf ? { [CSRF_HEADER]: csrf } : {} });
  if (!res.ok) {
    let message = 'The download could not be made. Open the space again and try once more.';
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') message = body.error.message;
    } catch {
      // keep the plain sentence
    }
    throw new ApiError({ code: 'internal', status: res.status, message });
  }
  return res.blob();
}

/**
 * Stores one file in a folder of the caller's Personal space: the body is the file itself, its name travels percent-encoded in `x-file-name`.
 * `conflict: 'version'` is how a note is saved (the old content is kept as a version); `'rename'` keeps both (`report (2).pdf`).
 */
export function uploadPersonalFile(folderPath: string, file: File, conflict: 'rename' | 'version', onProgress: (fraction: number) => void): Promise<PersonalFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(uploadPersonalFileRoute.method, `${buildPath(uploadPersonalFileRoute.path, undefined)}?${new URLSearchParams({ folderPath, conflict }).toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    const csrf = readCsrfCookie(document.cookie);
    if (csrf) xhr.setRequestHeader(CSRF_HEADER, csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError({ code: 'network', status: 0, message: 'The connection was lost before the file arrived.' }));
    xhr.onabort = () => reject(new ApiError({ code: 'network', status: 0, message: 'Cancelled' }));
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = PersonalFile.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError({ code: 'bad_response', status: xhr.status, message: 'The server sent a response this app does not understand.' }));
        return;
      }
      const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
      reject(
        new ApiError({
          code: xhr.status === 413 ? 'validation_failed' : 'internal',
          status: xhr.status,
          message: typeof message === 'string' ? message : xhr.status === 413 ? 'That file is too large, or your Personal files are over their allowance.' : `The upload failed (${String(xhr.status)}).`,
        }),
      );
    };
    xhr.send(file);
  });
}
