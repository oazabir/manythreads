import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import {
  KnowledgeBase,
  KnowledgeBaseName,
  KnowledgeBaseSlug,
  KnowledgeChunkId,
  KnowledgeDocument,
  KnowledgeDocumentId,
  KnowledgeHit,
  KnowledgeSearchMode,
} from '../../entities/knowledge.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// The routes of a team's knowledge bases (PLAN P8-07, P8-08, P8-31, P8-33). Everyone who can read the team reads; a team lead or a workspace admin
// writes. A guest reads nothing. docs/plugins/knowledge.md.

/** Largest file one upload takes (bytes); the server's `MANYTHREADS_KNOWLEDGE_MAX_BYTES` can lower or raise it. */
export const KNOWLEDGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Most bases one team may have, and most documents one base may hold. */
export const KNOWLEDGE_MAX_BASES_PER_TEAM = 20;
export const KNOWLEDGE_MAX_DOCUMENTS_PER_BASE = 200;

export const KnowledgeTeamParams = z.object({ slug: TeamSlug });
export type KnowledgeTeamParams = z.infer<typeof KnowledgeTeamParams>;
export const KnowledgeBaseParams = z.object({ slug: TeamSlug, base: KnowledgeBaseSlug });
export type KnowledgeBaseParams = z.infer<typeof KnowledgeBaseParams>;
export const KnowledgeDocumentParams = z.object({ slug: TeamSlug, base: KnowledgeBaseSlug, documentId: KnowledgeDocumentId });
export type KnowledgeDocumentParams = z.infer<typeof KnowledgeDocumentParams>;
export const KnowledgeChunkParams = z.object({ slug: TeamSlug, chunkId: KnowledgeChunkId });
export type KnowledgeChunkParams = z.infer<typeof KnowledgeChunkParams>;

export const ListKnowledgeBasesResponse = z.object({
  bases: z.array(KnowledgeBase),
  /** Whether the signed-in person may create bases and upload (a team lead or a workspace admin). */
  canWrite: z.boolean(),
  searchMode: KnowledgeSearchMode,
});
export type ListKnowledgeBasesResponse = z.infer<typeof ListKnowledgeBasesResponse>;
export const listKnowledgeBasesRoute = { method: 'GET', path: '/api/teams/:slug/knowledge' } as const satisfies ApiRoute;

export const CreateKnowledgeBaseRequest = z.strictObject({ slug: KnowledgeBaseSlug, name: KnowledgeBaseName.optional() });
export type CreateKnowledgeBaseRequest = z.infer<typeof CreateKnowledgeBaseRequest>;
export const KnowledgeBaseResponse = z.object({ base: KnowledgeBase });
export type KnowledgeBaseResponse = z.infer<typeof KnowledgeBaseResponse>;
export const createKnowledgeBaseRoute = { method: 'POST', path: '/api/teams/:slug/knowledge' } as const satisfies ApiRoute;

export const GetKnowledgeBaseResponse = z.object({
  base: KnowledgeBase,
  documents: z.array(KnowledgeDocument),
  canWrite: z.boolean(),
  searchMode: KnowledgeSearchMode,
});
export type GetKnowledgeBaseResponse = z.infer<typeof GetKnowledgeBaseResponse>;
export const getKnowledgeBaseRoute = { method: 'GET', path: '/api/teams/:slug/knowledge/:base' } as const satisfies ApiRoute;

export const DeleteKnowledgeBaseResponse = z.object({ removed: z.literal(true), documents: z.number().int().min(0) });
export type DeleteKnowledgeBaseResponse = z.infer<typeof DeleteKnowledgeBaseResponse>;
export const deleteKnowledgeBaseRoute = { method: 'DELETE', path: '/api/teams/:slug/knowledge/:base' } as const satisfies ApiRoute;

/** The upload's file name travels in `?name=` (or `x-file-name`); the body is the file itself. */
export const UploadKnowledgeDocumentQuery = z.object({ name: z.string().trim().min(1).max(200).optional() });
export type UploadKnowledgeDocumentQuery = z.infer<typeof UploadKnowledgeDocumentQuery>;
/**
 * `added`: a new document. `updated`: the same name with changed content, now at a new version. `unchanged`: the same content was already indexed, so
 * nothing moved and no new version was made. `failed`: the file was stored but could not be read (the document says why).
 */
export const KnowledgeUploadOutcome = z.enum(['added', 'updated', 'unchanged', 'failed']);
export type KnowledgeUploadOutcome = z.infer<typeof KnowledgeUploadOutcome>;
export const UploadKnowledgeDocumentResponse = z.object({ outcome: KnowledgeUploadOutcome, document: KnowledgeDocument });
export type UploadKnowledgeDocumentResponse = z.infer<typeof UploadKnowledgeDocumentResponse>;
export const uploadKnowledgeDocumentRoute = { method: 'POST', path: '/api/teams/:slug/knowledge/:base/documents' } as const satisfies ApiRoute;

export const DeleteKnowledgeDocumentResponse = z.object({ removed: z.literal(true) });
export type DeleteKnowledgeDocumentResponse = z.infer<typeof DeleteKnowledgeDocumentResponse>;
export const deleteKnowledgeDocumentRoute = { method: 'DELETE', path: '/api/teams/:slug/knowledge/:base/documents/:documentId' } as const satisfies ApiRoute;

/** What a re-sync did: how many documents it looked at, which moved, and which could not be read. */
export const KnowledgeResyncResult = z.object({
  checked: z.number().int().min(0),
  unchanged: z.number().int().min(0),
  updated: z.number().int().min(0),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  failed: z.number().int().min(0),
  at: IsoDateTime,
});
export type KnowledgeResyncResult = z.infer<typeof KnowledgeResyncResult>;
export const ResyncKnowledgeBaseResponse = z.object({ result: KnowledgeResyncResult, base: KnowledgeBase, documents: z.array(KnowledgeDocument) });
export type ResyncKnowledgeBaseResponse = z.infer<typeof ResyncKnowledgeBaseResponse>;
export const resyncKnowledgeBaseRoute = { method: 'POST', path: '/api/teams/:slug/knowledge/:base/resync' } as const satisfies ApiRoute;

export const SearchKnowledgeQuery = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type SearchKnowledgeQuery = z.infer<typeof SearchKnowledgeQuery>;
export const SearchKnowledgeResponse = z.object({ mode: KnowledgeSearchMode, hits: z.array(KnowledgeHit) });
export type SearchKnowledgeResponse = z.infer<typeof SearchKnowledgeResponse>;
export const searchKnowledgeRoute = { method: 'GET', path: '/api/teams/:slug/knowledge/:base/search' } as const satisfies ApiRoute;

/** One passage by id, at the version it was cited at. An older version stays readable and says the source has changed since. */
export const GetKnowledgeChunkResponse = z.object({ hit: KnowledgeHit });
export type GetKnowledgeChunkResponse = z.infer<typeof GetKnowledgeChunkResponse>;
export const getKnowledgeChunkRoute = { method: 'GET', path: '/api/teams/:slug/knowledge-chunks/:chunkId' } as const satisfies ApiRoute;
