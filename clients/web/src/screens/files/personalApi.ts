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
  MAX_FILES_TREE_ENTRIES,
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
import { ApiError, CSRF_HEADER, buildPath, call, emitSessionExpired, readCsrfCookie } from '../../api/client';
import { isMockMode } from '../../api/setup';
import { bytesLabel } from './model';
import { mockOpenSpace, mockOpens } from './personalMock';

/*
 * The calls behind a person's own files (`/api/me/files/*`) and the admin's open of a Personal space. The shapes are the shared contract
 * (`packages/shared/src/api/files/personal.ts`); this file only sends and parses.
 */

/** A Personal folder asks for the most the server gives (2000 rows), so a file past the default 500 is still found and opened. */
export const fetchMyTree = (path: string, limit: number = MAX_FILES_TREE_ENTRIES) =>
  call(getMyFilesTreeRoute, { request: GetFilesTreeQuery, response: GetFilesTreeResponse }, GetFilesTreeQuery.parse({ path, limit }));

export const fetchPersonTree = (personId: string, path: string) =>
  call(getPersonFilesTreeRoute, { request: GetFilesTreeQuery, response: PersonFilesTreeResponse }, GetFilesTreeQuery.parse({ path, limit: MAX_FILES_TREE_ENTRIES }), { personId });

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

/** What a browser without "save straight to disk" may hold in memory for one download. Larger spaces need a browser that can write to disk as the bytes arrive. */
export const EXPORT_MEMORY_CAP = 512 * 1024 * 1024;

type DiskWriter = { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> };
type SaveFilePicker = (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<{ createWritable: () => Promise<DiskWriter> }>;

const diskPicker = (): SaveFilePicker | null => {
  const w = window as unknown as { showSaveFilePicker?: SaveFilePicker };
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker.bind(window) : null;
};

/** The sentence for an export that cannot be made, from the server's own words when it gave some. */
async function exportFailure(res: Response): Promise<ApiError> {
  if (res.status === 401) emitSessionExpired();
  let message = 'The download could not be made. Open the space again and try once more.';
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // keep the plain sentence
  }
  return new ApiError({ code: 'internal', status: res.status, message });
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Downloads a person's whole space (needs a live open) as one zip. The server streams the zip, and a space can be several GiB, so where the browser can
 * write to a file as the bytes arrive (Chrome and Edge) nothing is held in memory; elsewhere the zip is collected in memory up to `EXPORT_MEMORY_CAP`
 * and a larger one is refused in words instead of freezing the tab. Returns `cancelled` when the person closed the "save as" window.
 * Call it straight from the click: the "save as" window needs that click.
 */
export async function savePersonalSpaceZip(personId: string, fileName: string): Promise<'saved' | 'cancelled'> {
  if (isMockMode()) {
    saveBlob(new Blob(['Personal space export (sample)'], { type: 'application/zip' }), fileName);
    return 'saved';
  }
  let disk: DiskWriter | null = null;
  const pick = diskPicker();
  if (pick) {
    try {
      disk = await (await pick({ suggestedName: fileName, types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }] })).createWritable();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      disk = null; // the window could not open: fall back to the in-memory way
    }
  }
  const csrf = readCsrfCookie(document.cookie);
  let res: Response;
  try {
    res = await fetch(buildPath(exportPersonalSpaceRoute.path, { personId }), { method: exportPersonalSpaceRoute.method, credentials: 'same-origin', headers: csrf ? { [CSRF_HEADER]: csrf } : {} });
  } catch {
    await disk?.abort().catch(() => undefined);
    throw new ApiError({ code: 'network', status: 0, message: 'The connection was lost before the download started.' });
  }
  if (!res.ok) {
    await disk?.abort().catch(() => undefined);
    throw await exportFailure(res);
  }
  const tooBig = new ApiError({
    code: 'validation_failed',
    status: 413,
    message: `This space is too big to download in this browser (over ${bytesLabel(EXPORT_MEMORY_CAP)}). Use Chrome or Edge on a computer, which can save a large download straight to disk.`,
  });
  const reader = res.body?.getReader();
  if (!reader) {
    const blob = await res.blob();
    if (blob.size > EXPORT_MEMORY_CAP) throw tooBig;
    saveBlob(blob, fileName);
    return 'saved';
  }
  const declared = Number(res.headers.get('content-length'));
  if (!disk && Number.isFinite(declared) && declared > EXPORT_MEMORY_CAP) {
    await reader.cancel().catch(() => undefined);
    throw tooBig;
  }
  const kept: Uint8Array[] = [];
  let held = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (disk) await disk.write(value);
      else {
        held += value.byteLength;
        if (held > EXPORT_MEMORY_CAP) {
          await reader.cancel().catch(() => undefined);
          throw tooBig;
        }
        kept.push(value);
      }
    }
    if (disk) await disk.close();
  } catch (err) {
    await disk?.abort().catch(() => undefined);
    throw err instanceof ApiError ? err : new ApiError({ code: 'network', status: 0, message: 'The download stopped before it was finished. Try again.' });
  }
  if (!disk) saveBlob(new Blob(kept as BlobPart[], { type: 'application/zip' }), fileName);
  return 'saved';
}

/**
 * The 413 sentence for a screen. The server names its upload limit in bytes ("larger than the 26214400 byte limit"), which nobody reads; its allowance
 * sentence is already plain and is kept.
 */
export function tooLargeWords(serverMessage: string): string {
  const limit = /(\d{4,})\s*byte limit/.exec(serverMessage);
  if (limit) return `That file is larger than ${bytesLabel(Number(limit[1]))}, the most that can be uploaded at once.`;
  return serverMessage.startsWith('That would take you over') ? serverMessage : 'That file is too large, or your Personal files are over their allowance.';
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
      if (xhr.status === 401) emitSessionExpired();
      const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
      reject(
        new ApiError({
          code: xhr.status === 413 ? 'validation_failed' : 'internal',
          status: xhr.status,
          message: xhr.status === 413 ? tooLargeWords(typeof message === 'string' ? message : '') : typeof message === 'string' ? message : `The upload failed (${String(xhr.status)}).`,
        }),
      );
    };
    xhr.send(file);
  });
}
