import {
  AddKnowledgeConnectorSourceRequest,
  AddKnowledgeConnectorSourceResponse,
  ListConnectorProvidersResponse,
  ListConnectorRootsQuery,
  ListConnectorRootsResponse,
  addKnowledgeConnectorSourceRoute,
  addPersonalKnowledgeConnectorSourceRoute,
  listConnectorProvidersRoute,
  listConnectorRootsRoute,
  CreatePersonalKnowledgeBaseRequest,
  DeletePersonalKnowledgeBaseResponse,
  DeletePersonalKnowledgeDocumentResponse,
  GetPersonalKnowledgeBaseResponse,
  ListKnowledgeBasesResponse,
  ListPersonalKnowledgeBasesResponse,
  PersonalKnowledgeBaseResponse,
  PersonalSearchKnowledgeQuery,
  SearchPersonalKnowledgeResponse,
  UploadPersonalKnowledgeDocumentResponse,
  createPersonalKnowledgeBaseRoute,
  deletePersonalKnowledgeBaseRoute,
  deletePersonalKnowledgeDocumentRoute,
  getPersonalKnowledgeBaseRoute,
  listKnowledgeBasesRoute,
  listPersonalKnowledgeBasesRoute,
  searchPersonalKnowledgeRoute,
  uploadPersonalKnowledgeDocumentRoute,
} from '@manythreads/shared';
import { ApiError, CSRF_HEADER, buildPath, call, readCsrfCookie } from '../../api/client';
import { isMockMode } from '../../api/setup';

/*
 * What the Knowledge screen asks of the server (docs/plugins/knowledge.md). A person's own bases live under `/api/me/knowledge`; the owner is never a parameter, so
 * there is no way to ask for another person's bases from here. A team's bases are listed by the team route and shown with the panel the bot page already uses.
 */

export const fetchPersonalBases = () => call(listPersonalKnowledgeBasesRoute, { response: ListPersonalKnowledgeBasesResponse });

export const fetchPersonalBase = (base: string) => call(getPersonalKnowledgeBaseRoute, { response: GetPersonalKnowledgeBaseResponse }, undefined, { base });

export const createPersonalBase = (body: CreatePersonalKnowledgeBaseRequest) =>
  call(createPersonalKnowledgeBaseRoute, { request: CreatePersonalKnowledgeBaseRequest, response: PersonalKnowledgeBaseResponse }, CreatePersonalKnowledgeBaseRequest.parse(body));

export const deletePersonalBase = (base: string) => call(deletePersonalKnowledgeBaseRoute, { response: DeletePersonalKnowledgeBaseResponse }, undefined, { base });

export const deletePersonalDocument = (base: string, documentId: string) =>
  call(deletePersonalKnowledgeDocumentRoute, { response: DeletePersonalKnowledgeDocumentResponse }, undefined, { base, documentId });

export const searchPersonalBase = (base: string, q: string) =>
  call(searchPersonalKnowledgeRoute, { request: PersonalSearchKnowledgeQuery, response: SearchPersonalKnowledgeResponse }, PersonalSearchKnowledgeQuery.parse({ q, limit: 5 }), { base });

/** A team's bases, for the Teams side of the screen. */
export const fetchTeamBases = (slug: string) => call(listKnowledgeBasesRoute, { response: ListKnowledgeBasesResponse }, undefined, { slug });

/**
 * Upload one file to a personal base as raw bytes (XHR, so a big file can show progress). A refusal comes back as the same `ApiError` as every other call. The mock
 * has no byte stream: it is told the name and the size as JSON instead.
 */
export function uploadPersonalDocument(base: string, file: File, onProgress: (fraction: number) => void): Promise<UploadPersonalKnowledgeDocumentResponse> {
  if (isMockMode()) {
    return call(uploadPersonalKnowledgeDocumentRoute, { response: UploadPersonalKnowledgeDocumentResponse }, { name: file.name, size: file.size }, { base }).then((r) => {
      onProgress(1);
      return r;
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(uploadPersonalKnowledgeDocumentRoute.method, `${buildPath(uploadPersonalKnowledgeDocumentRoute.path, { base })}?${new URLSearchParams({ name: file.name }).toString()}`);
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
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = UploadPersonalKnowledgeDocumentResponse.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError({ code: 'bad_response', status: xhr.status, message: 'The server sent a response this app does not understand.' }));
        return;
      }
      const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
      reject(
        new ApiError({
          code: xhr.status === 413 || xhr.status === 415 ? 'validation_failed' : xhr.status === 429 ? 'rate_limited' : 'internal',
          status: xhr.status,
          message: typeof message === 'string' ? message : `The upload failed (${String(xhr.status)}).`,
        }),
      );
    };
    xhr.send(file);
  });
}

// ---- Bundle D: sources read from a connected app (docs/plugins/knowledge.md "Bundle D contracts") --------------------------------------------------------------
export const addTeamConnectorSource = (slug: string, base: string, body: AddKnowledgeConnectorSourceRequest) =>
  call(addKnowledgeConnectorSourceRoute, { request: AddKnowledgeConnectorSourceRequest, response: AddKnowledgeConnectorSourceResponse }, body, { slug, base });
export const addPersonalConnectorSource = (base: string, body: AddKnowledgeConnectorSourceRequest) =>
  call(addPersonalKnowledgeConnectorSourceRoute, { request: AddKnowledgeConnectorSourceRequest, response: AddKnowledgeConnectorSourceResponse }, body, { base });
/** The folders, spaces, sites or databases the caller's own connection offers for a service. */
export const fetchConnectorRoots = (query: ListConnectorRootsQuery) =>
  call(listConnectorRootsRoute, { request: ListConnectorRootsQuery, response: ListConnectorRootsResponse }, query);
export const fetchConnectorProviders = () => call(listConnectorProvidersRoute, { response: ListConnectorProvidersResponse });
