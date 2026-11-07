import {
  CreatePersonalInboxNoteRequest,
  GetPersonalInboxItemResponse,
  GetPersonalMemoryFileResponse,
  ListPersonalInboxQuery,
  ListPersonalInboxResponse,
  ListPersonalMemoryResponse,
  ListPersonalMemoryVersionsResponse,
  DeletePersonalMemoryResponse,
  PersonalInboxActionResponse,
  PersonalInboxItemResponse,
  PersonalMemoryPathQuery,
  RestorePersonalMemoryRequest,
  SendPersonalInboxToTeamRequest,
  SendPersonalInboxToTeamResponse,
  WritePersonalMemoryRequest,
  WritePersonalMemoryResponse,
  createPersonalInboxNoteRoute,
  deletePersonalMemoryRoute,
  discardPersonalInboxRoute,
  getPersonalInboxItemRoute,
  getPersonalMemoryFileRoute,
  listPersonalInboxRoute,
  listPersonalMemoryRoute,
  listPersonalMemoryVersionsRoute,
  releasePersonalInboxRoute,
  restorePersonalMemoryRoute,
  retryPersonalInboxRoute,
  sendPersonalInboxToTeamRoute,
  uploadPersonalInboxRoute,
  writePersonalMemoryRoute,
  type InboxState,
} from '@manythreads/shared';
import { ApiError, CSRF_HEADER, buildPath, call, readCsrfCookie } from '../../api/client';
import { isMockMode } from '../../api/setup';

/*
 * What the Memory screen asks of the server for a person's own space (docs/plugins/memory.md, docs/plugins/memory-inbox.md): their memory files under
 * `/api/me/memory/*` and their own inbox under `/api/me/inbox/*`. The owner is never a parameter: the server acts for whoever is signed in, so there is no way
 * to ask for another person's data from here.
 */

// ---- Personal memory ------------------------------------------------------------------------------------------------------------

export const fetchPersonalConcepts = () => call(listPersonalMemoryRoute, { response: ListPersonalMemoryResponse });

export const fetchPersonalFile = (path: string) =>
  call(getPersonalMemoryFileRoute, { request: PersonalMemoryPathQuery, response: GetPersonalMemoryFileResponse }, PersonalMemoryPathQuery.parse({ path }));

/** Save a file. `baseVersion` is the version the edit started from; a file that moved since is refused with a 409 whose sentence says so. */
export const savePersonalFile = (body: WritePersonalMemoryRequest) =>
  call(writePersonalMemoryRoute, { request: WritePersonalMemoryRequest, response: WritePersonalMemoryResponse }, WritePersonalMemoryRequest.parse(body));

/** The path of a DELETE is a query, and the shared client sends a body on those, so the query is put on the address here (as the Files screen does). */
export const removePersonalFile = (path: string) =>
  call({ ...deletePersonalMemoryRoute, path: `${deletePersonalMemoryRoute.path}?path=${encodeURIComponent(path)}` }, { response: DeletePersonalMemoryResponse });

export const fetchPersonalVersions = (path: string) =>
  call(listPersonalMemoryVersionsRoute, { request: PersonalMemoryPathQuery, response: ListPersonalMemoryVersionsResponse }, PersonalMemoryPathQuery.parse({ path }));

export const restorePersonalVersion = (path: string, versionNo: number) =>
  call(restorePersonalMemoryRoute, { request: RestorePersonalMemoryRequest, response: WritePersonalMemoryResponse }, RestorePersonalMemoryRequest.parse({ path, versionNo }));

// ---- the person's own inbox -----------------------------------------------------------------------------------------------------

export const fetchPersonalInbox = (state?: InboxState) =>
  call(listPersonalInboxRoute, { request: ListPersonalInboxQuery, response: ListPersonalInboxResponse }, ListPersonalInboxQuery.parse({ limit: 200, ...(state ? { state } : {}) }));

export const fetchPersonalInboxItem = (itemId: string) => call(getPersonalInboxItemRoute, { response: GetPersonalInboxItemResponse }, undefined, { itemId });

export const releasePersonalItem = (itemId: string) => call(releasePersonalInboxRoute, { response: PersonalInboxActionResponse }, undefined, { itemId });
export const discardPersonalItem = (itemId: string) => call(discardPersonalInboxRoute, { response: PersonalInboxActionResponse }, undefined, { itemId });
export const retryPersonalItem = (itemId: string) => call(retryPersonalInboxRoute, { response: PersonalInboxActionResponse }, undefined, { itemId });

export const createPersonalNote = (body: CreatePersonalInboxNoteRequest) =>
  call(createPersonalInboxNoteRoute, { request: CreatePersonalInboxNoteRequest, response: PersonalInboxItemResponse }, CreatePersonalInboxNoteRequest.parse(body));

/** "Send to team": a copy of the original is dropped into the team's inbox as the person; the personal item stays. */
export const sendPersonalItemToTeam = (itemId: string, body: SendPersonalInboxToTeamRequest) =>
  call(sendPersonalInboxToTeamRoute, { request: SendPersonalInboxToTeamRequest, response: SendPersonalInboxToTeamResponse }, SendPersonalInboxToTeamRequest.parse(body), { itemId });

/** The mock has no byte stream: it is told the name and the size as JSON instead. */
type MockDrop = { name: string; size: number };

/**
 * Drops one file into the person's own inbox: the body is the file itself and its name travels in `?name=`. The answer is parsed with the shared schema and a
 * refusal comes back as the same `ApiError` every other call throws (the server's sentence is kept: too large, a kind it cannot read, too many at once).
 */
export function uploadPersonalFile(file: File, onProgress: (fraction: number) => void): Promise<PersonalInboxItemResponse> {
  if (isMockMode()) {
    const body: MockDrop = { name: file.name, size: file.size };
    return call(uploadPersonalInboxRoute, { response: PersonalInboxItemResponse }, body).then((r) => {
      onProgress(1);
      return r;
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(uploadPersonalInboxRoute.method, `${buildPath(uploadPersonalInboxRoute.path, {})}?${new URLSearchParams({ name: file.name }).toString()}`);
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
        const parsed = PersonalInboxItemResponse.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError({ code: 'bad_response', status: xhr.status, message: 'The server sent a response this app does not understand.' }));
        return;
      }
      const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
      reject(
        new ApiError({
          code: xhr.status === 413 || xhr.status === 415 ? 'validation_failed' : xhr.status === 429 ? 'rate_limited' : 'internal',
          status: xhr.status,
          message: typeof message === 'string' ? message : `The file could not be dropped (${String(xhr.status)}).`,
        }),
      );
    };
    xhr.send(file);
  });
}
