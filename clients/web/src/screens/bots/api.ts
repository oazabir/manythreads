import {
  BotTestRequest,
  BotTestResult,
  BotTestStarted,
  botTestResultRoute,
  botTestRoute,
  CreateKnowledgeBaseRequest,
  GetBotEvalsResponse,
  GetKnowledgeBaseResponse,
  KnowledgeBaseResponse,
  ResyncKnowledgeBaseResponse,
  SearchKnowledgeQuery,
  SearchKnowledgeResponse,
  UploadKnowledgeDocumentResponse,
  createKnowledgeBaseRoute,
  deleteKnowledgeDocumentRoute,
  getKnowledgeBaseRoute,
  resyncKnowledgeBaseRoute,
  searchKnowledgeRoute,
  uploadKnowledgeDocumentRoute,
  DeleteKnowledgeDocumentResponse,
  GetBotResponse,
  GetRepoBlobQuery,
  GetRepoBlobResponse,
  ListBotsResponse,
  RunEvalsRequest,
  RunEvalsResponse,
  botMdPath,
  getBotEvalsRoute,
  getBotRoute,
  getRepoBlobRoute,
  listBotsRoute,
  runEvalsRoute,
} from '@manythreads/shared';
import { ApiError, CSRF_HEADER, buildPath, call, readCsrfCookie } from '../../api/client';
import { createProposal } from '../proposals/api';

/*
 * What the Bots screens ask of the server (PLAN P5-05). Two reads over the bots plugin — the roster and one bot — plus the definition
 * itself, which is a file of the team repo: read through `repo/blob`, saved as a proposal with the blob that was read (`baseBlobSha`). The repo
 * writer's own rules still decide who may apply it: a team lead edits a bot that exists, a workspace admin adds or removes one.
 */

export const fetchBots = (slug: string) => call(listBotsRoute, { response: ListBotsResponse }, undefined, { slug });

export const fetchBot = (slug: string, botSlug: string) => call(getBotRoute, { response: GetBotResponse }, undefined, { slug, botSlug });

/** The definition file as the loader reads it: the text and the blob a save must be based on. */
export type DefinitionFile = { content: string; blobSha: string; commitSha: string };

export async function readDefinition(slug: string, path: string): Promise<DefinitionFile> {
  const b = await call(getRepoBlobRoute, { request: GetRepoBlobQuery, response: GetRepoBlobResponse }, GetRepoBlobQuery.parse({ path }), { slug });
  return { content: b.encoding === 'utf8' ? b.content : new TextDecoder().decode(Uint8Array.from(atob(b.content), (c) => c.charCodeAt(0))), blobSha: b.blobSha, commitSha: b.commitSha };
}

/**
 * The whole file as a proposal (PLAN P7-01): bots/ is never committed directly. With `applyNow` a team lead or workspace admin proposes and applies in
 * one step (the commit is theirs, a proposal stays on record); without it the proposal waits for a lead or admin. `baseBlobSha` is the blob the page
 * read: a file someone else changed in the meantime is refused with 409 and nothing is overwritten. A BOT.md that does not load is refused with 422 and
 * the loader's own words.
 */
export async function proposeDefinition(
  slug: string,
  path: string,
  content: string,
  baseBlobSha: string | null,
  title: string,
  applyNow: boolean,
): Promise<{ proposalId: string; applied: boolean; noop: boolean }> {
  const res = await createProposal(slug, { path, op: 'put', content, baseBlobSha, title, ...(applyNow ? { applyNow: true } : {}) });
  return { proposalId: res.proposal.proposal.id, applied: res.proposal.proposal.status === 'applied', noop: false };
}

export { botMdPath };

/** Why there is no Talk button on a bot whose definition has no `conversation` trigger: the router answers a conversation only for that trigger. */

/** A bot's evals: the newest runs and whether the signed-in person may start one (PLAN P7-08). */
export const fetchEvals = (slug: string, botSlug: string) => call(getBotEvalsRoute, { response: GetBotEvalsResponse }, undefined, { slug, botSlug });

/** Start a run of the bot's scenario set. `static` is free; `model` costs tokens. The answer is the run, still `running`. */
export const startEvals = (slug: string, botSlug: string, mode: 'static' | 'model') =>
  call(runEvalsRoute, { request: RunEvalsRequest, response: RunEvalsResponse }, RunEvalsRequest.parse({ mode }), { slug, botSlug });

// ---- knowledge (PLAN P8-33) --------------------------------------------------------------------------------------------
export const fetchKnowledgeBase = (slug: string, base: string) => call(getKnowledgeBaseRoute, { response: GetKnowledgeBaseResponse }, undefined, { slug, base });

export const createKnowledgeBase = (slug: string, body: CreateKnowledgeBaseRequest) =>
  call(createKnowledgeBaseRoute, { request: CreateKnowledgeBaseRequest, response: KnowledgeBaseResponse }, body, { slug });

export const resyncKnowledgeBase = (slug: string, base: string) => call(resyncKnowledgeBaseRoute, { response: ResyncKnowledgeBaseResponse }, undefined, { slug, base });

export const deleteKnowledgeDocument = (slug: string, base: string, documentId: string) =>
  call(deleteKnowledgeDocumentRoute, { response: DeleteKnowledgeDocumentResponse }, undefined, { slug, base, documentId });

export const askKnowledgeBase = (slug: string, base: string, q: string) =>
  call(searchKnowledgeRoute, { request: SearchKnowledgeQuery, response: SearchKnowledgeResponse }, { q, limit: 5 } as SearchKnowledgeQuery, { slug, base });

/** Upload one file to a base as raw bytes (XHR, so a big file can show progress). A refusal comes back as the same `ApiError` as every other call. */
export function uploadKnowledgeDocument(slug: string, base: string, file: File, onProgress: (fraction: number) => void): Promise<UploadKnowledgeDocumentResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(uploadKnowledgeDocumentRoute.method, buildPath(uploadKnowledgeDocumentRoute.path, { slug, base }));
    xhr.withCredentials = true;
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    const csrf = readCsrfCookie(document.cookie);
    if (csrf) xhr.setRequestHeader(CSRF_HEADER, csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError({ code: 'network', status: 0, message: 'Network error' }));
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = UploadKnowledgeDocumentResponse.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError({ code: 'bad_response', status: xhr.status, message: 'The server sent a response this app does not understand.' }));
        return;
      }
      const message = typeof (body as { error?: { message?: unknown } } | undefined)?.error?.message === 'string' ? (body as { error: { message: string } }).error.message : `Upload failed (${String(xhr.status)})`;
      reject(new ApiError({ code: xhr.status === 413 || xhr.status === 415 ? 'validation_failed' : 'internal', status: xhr.status, message }));
    };
    xhr.send(file);
  });
}

// ---- the Test action (PLAN P7-11) --------------------------------------------------------------------------------------
/** Ask the bot one question as a rehearsal, in the signed-in person's own conversation with it. The answer is a reply in the question's thread. */
export const startBotTest = (slug: string, botSlug: string, question: string) =>
  call(botTestRoute, { request: BotTestRequest, response: BotTestStarted }, BotTestRequest.parse({ question }), { slug, botSlug });

/** Where the test stands: the run's state, the writes held back, and what the answer rested on. */
export const fetchBotTest = (slug: string, botSlug: string, messageId: string) =>
  call(botTestResultRoute, { response: BotTestResult }, undefined, { slug, botSlug, messageId });
