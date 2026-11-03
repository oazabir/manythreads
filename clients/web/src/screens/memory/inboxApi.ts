import { z } from 'zod';
import {
  CreateInboxNoteRequest,
  GetInboxItemResponse,
  InboxEmailResponse,
  InboxItemActionResponse,
  InboxItemResponse,
  ListInboxActionsResponse,
  ListInboxItemsQuery,
  ListInboxItemsResponse,
  ListMemoryConceptsResponse,
  RecordInboxActionRequest,
  RecordInboxActionResponse,
  SendToMemoryRequest,
  SetUpInboxMailResponse,
  createInboxNoteRoute,
  discardInboxItemRoute,
  getInboxEmailRoute,
  getInboxItemRoute,
  listInboxActionsRoute,
  listInboxItemsRoute,
  listMemoryConceptsRoute,
  recordInboxActionRoute,
  releaseInboxItemRoute,
  retryInboxItemRoute,
  sendToMemoryRoute,
  setUpInboxMailRoute,
  uploadInboxItemRoute,
  type InboxAction,
  type InboxState,
  type TaskId,
} from '@manythreads/shared';
import { ApiError, CSRF_HEADER, buildPath, call, readCsrfCookie } from '../../api/client';
import { isMockMode } from '../../api/setup';
import { createTask } from '../boards/api';

/*
 * What the Memory screen asks of the server for a team's inbox (docs/plugins/memory-inbox.md): the queue, the team's email address (the email door), the
 * workspace admin's "switch it on", and the action items a filed item became (each with an "Add to board" the person clicks).
 */

export const fetchInboxItems = (slug: string, state?: InboxState) =>
  call(listInboxItemsRoute, { request: ListInboxItemsQuery, response: ListInboxItemsResponse }, ListInboxItemsQuery.parse({ limit: 200, ...(state ? { state } : {}) }), { slug });

/** The team's address on the workspace mailbox, or why there is none yet and whether the signed-in person may set the mailbox up. */
export const fetchInboxEmail = (slug: string) => call(getInboxEmailRoute, { response: InboxEmailResponse }, undefined, { slug });

/** A workspace admin switches the workspace mailbox on. The same answer the second time. */
export const setUpInboxMail = () => call(setUpInboxMailRoute, { response: SetUpInboxMailResponse }, undefined, {});

/** The actions of the item's `Action Items` concepts, each with the card body ready to send. */
export const fetchInboxActions = (slug: string, itemId: string) => call(listInboxActionsRoute, { response: ListInboxActionsResponse }, undefined, { slug, itemId });

export const recordInboxAction = (slug: string, itemId: string, body: RecordInboxActionRequest) =>
  call(recordInboxActionRoute, { request: RecordInboxActionRequest, response: RecordInboxActionResponse }, body, { slug, itemId });

/**
 * "Add to board": the card is made by the signed-in person through the tasks API (the server's `prepared` body, as it is), never by a bot or the platform; then the
 * inbox is told which action it was so the action shows as added for everyone. If the second call fails the card exists: the caller says so instead of making another.
 */
export async function addActionToBoard(slug: string, itemId: string, action: InboxAction): Promise<{ action: InboxAction; taskId: TaskId; recorded: boolean; problem?: string }> {
  const { task } = await createTask(slug, action.prepared);
  try {
    const answer = await recordInboxAction(slug, itemId, { conceptPath: action.conceptPath, index: action.index, taskId: task.id });
    return { action: answer.action, taskId: task.id, recorded: true };
  } catch (e) {
    return { action: { ...action, taskId: task.id }, taskId: task.id, recorded: false, problem: e instanceof Error ? e.message : 'The card was made, but the inbox could not note it.' };
  }
}

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
