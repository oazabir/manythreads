import { z } from 'zod';
import {
  CreateInboxNoteRequest,
  GetInboxItemResponse,
  InboxItemActionResponse,
  InboxItemResponse,
  ListInboxItemsQuery,
  ListInboxItemsResponse,
  ListMemoryConceptsResponse,
  SendToMemoryRequest,
  createInboxNoteRoute,
  discardInboxItemRoute,
  getInboxItemRoute,
  listInboxItemsRoute,
  listMemoryConceptsRoute,
  releaseInboxItemRoute,
  retryInboxItemRoute,
  sendToMemoryRoute,
  uploadInboxItemRoute,
  type InboxState,
} from '@manythreads/shared';
import { ApiError, CSRF_HEADER, buildPath, call, readCsrfCookie } from '../../api/client';
import { isMockMode } from '../../api/setup';

/*
 * What the Memory screen asks of the server for a team's inbox (docs/plugins/memory-inbox.md). The list answer may also carry the team's email address
 * (the email door); an older server sends none, so the field is optional and the page shows nothing for it then.
 */

/** The list answer, plus the team's email address when the server has one. */
export const InboxListWithAddress = ListInboxItemsResponse.extend({ emailAddress: z.string().max(320).nullish() });
export type InboxListWithAddress = z.infer<typeof InboxListWithAddress>;

export const fetchInboxItems = (slug: string, state?: InboxState) =>
  call(listInboxItemsRoute, { request: ListInboxItemsQuery, response: InboxListWithAddress }, ListInboxItemsQuery.parse({ limit: 200, ...(state ? { state } : {}) }), { slug });

export const fetchInboxItem = (slug: string, itemId: string) => call(getInboxItemRoute, { response: GetInboxItemResponse }, undefined, { slug, itemId });

export const releaseInboxItem = (slug: string, itemId: string) => call(releaseInboxItemRoute, { response: InboxItemActionResponse }, undefined, { slug, itemId });
export const discardInboxItem = (slug: string, itemId: string) => call(discardInboxItemRoute, { response: InboxItemActionResponse }, undefined, { slug, itemId });
export const retryInboxItem = (slug: string, itemId: string) => call(retryInboxItemRoute, { response: InboxItemActionResponse }, undefined, { slug, itemId });

export const createInboxNote = (slug: string, body: CreateInboxNoteRequest) =>
  call(createInboxNoteRoute, { request: CreateInboxNoteRequest, response: InboxItemResponse }, body, { slug });

export const sendToMemory = (channelId: string, messageId: string, body: SendToMemoryRequest) =>
  call(sendToMemoryRoute, { request: SendToMemoryRequest, response: InboxItemResponse }, body, { channelId, messageId });

/** The mock has no byte stream: it is told the name and the choice as JSON instead. */
const MockDrop = z.object({ name: z.string(), teamOnly: z.boolean(), size: z.number() });

/**
 * Drops one file: the body is the file itself and its name travels in `?name=`. The answer is parsed with the shared schema and a refusal comes back as the
 * same `ApiError` every other call throws (the server's sentence is kept: too large, a kind it cannot read, too many at once).
 */
export function uploadInboxFile(slug: string, file: File, teamOnly: boolean, onProgress: (fraction: number) => void): Promise<InboxItemResponse> {
  if (isMockMode()) {
    return call(uploadInboxItemRoute, { request: MockDrop, response: InboxItemResponse }, { name: file.name, teamOnly, size: file.size }, { slug }).then((r) => {
      onProgress(1);
      return r;
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ name: file.name });
    if (teamOnly) query.set('teamOnly', 'true');
    xhr.open(uploadInboxItemRoute.method, `${buildPath(uploadInboxItemRoute.path, { slug })}?${query.toString()}`);
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
        const parsed = InboxItemResponse.safeParse(body);
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

/** The concepts of a team's memory (the Concepts tab and the links from the inbox cards). */
export const fetchConcepts = (slug: string) => call(listMemoryConceptsRoute, { response: ListMemoryConceptsResponse }, undefined, { slug });
