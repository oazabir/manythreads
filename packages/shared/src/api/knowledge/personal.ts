import { z } from 'zod';
import { KnowledgeBase, KnowledgeBaseSlug, KnowledgeDocument, KnowledgeDocumentId, KnowledgeSearchMode, KnowledgeSource } from '../../entities/knowledge.ts';
import { SpaceRef } from '../../entities/space.ts';
import { PersonId } from '../../ids.ts';
import type { ApiRoute } from '../client/route.ts';
import { AddKnowledgeUrlSourceRequest, CreateKnowledgeBaseRequest, KnowledgeUploadOutcome, SearchKnowledgeQuery, UploadKnowledgeDocumentQuery } from './index.ts';
import { KnowledgeHit } from '../../entities/knowledge.ts';

// A person's own knowledge bases (P20-06, D10): files and web pages only the owner (and Brain, when they ask it) can search. Same shapes as a team's bases,
// without a team and without the converted copy in a team repo (a Personal space is never git). Q7: uploads and web pages now; Drive and Notion arrive with the
// Drive sync. A guest has no Personal space. docs/plugins/knowledge.md.

/** Most bases a person may have (a team may have 20). */
export const KNOWLEDGE_MAX_PERSONAL_BASES = 10;

/** A base of a person: the shape of a team's base, without a team or a repo folder. `space` is `person:<id>`. */
export const PersonalKnowledgeBase = KnowledgeBase.omit({ teamId: true, repoFolder: true }).extend({ personId: PersonId, space: SpaceRef });
export type PersonalKnowledgeBase = z.infer<typeof PersonalKnowledgeBase>;

export const PersonalKnowledgeBaseParams = z.object({ base: KnowledgeBaseSlug });
export type PersonalKnowledgeBaseParams = z.infer<typeof PersonalKnowledgeBaseParams>;
export const PersonalKnowledgeDocumentParams = z.object({ base: KnowledgeBaseSlug, documentId: KnowledgeDocumentId });
export type PersonalKnowledgeDocumentParams = z.infer<typeof PersonalKnowledgeDocumentParams>;
export const PersonalKnowledgeSourceParams = z.object({ base: KnowledgeBaseSlug, sourceId: z.uuid() });
export type PersonalKnowledgeSourceParams = z.infer<typeof PersonalKnowledgeSourceParams>;

export const ListPersonalKnowledgeBasesResponse = z.object({ bases: z.array(PersonalKnowledgeBase), searchMode: KnowledgeSearchMode });
export type ListPersonalKnowledgeBasesResponse = z.infer<typeof ListPersonalKnowledgeBasesResponse>;
export const listPersonalKnowledgeBasesRoute = { method: 'GET', path: '/api/me/knowledge' } as const satisfies ApiRoute;

export const CreatePersonalKnowledgeBaseRequest = CreateKnowledgeBaseRequest;
export type CreatePersonalKnowledgeBaseRequest = z.infer<typeof CreatePersonalKnowledgeBaseRequest>;
export const PersonalKnowledgeBaseResponse = z.object({ base: PersonalKnowledgeBase });
export type PersonalKnowledgeBaseResponse = z.infer<typeof PersonalKnowledgeBaseResponse>;
export const createPersonalKnowledgeBaseRoute = { method: 'POST', path: '/api/me/knowledge' } as const satisfies ApiRoute;

export const GetPersonalKnowledgeBaseResponse = z.object({
  base: PersonalKnowledgeBase,
  documents: z.array(KnowledgeDocument.omit({ repoPath: true })),
  sources: z.array(KnowledgeSource),
  searchMode: KnowledgeSearchMode,
});
export type GetPersonalKnowledgeBaseResponse = z.infer<typeof GetPersonalKnowledgeBaseResponse>;
export const getPersonalKnowledgeBaseRoute = { method: 'GET', path: '/api/me/knowledge/:base' } as const satisfies ApiRoute;

export const DeletePersonalKnowledgeBaseResponse = z.object({ removed: z.literal(true), documents: z.number().int().min(0) });
export type DeletePersonalKnowledgeBaseResponse = z.infer<typeof DeletePersonalKnowledgeBaseResponse>;
export const deletePersonalKnowledgeBaseRoute = { method: 'DELETE', path: '/api/me/knowledge/:base' } as const satisfies ApiRoute;

export const PersonalUploadKnowledgeQuery = UploadKnowledgeDocumentQuery;
export const UploadPersonalKnowledgeDocumentResponse = z.object({ outcome: KnowledgeUploadOutcome, document: KnowledgeDocument.omit({ repoPath: true }) });
export type UploadPersonalKnowledgeDocumentResponse = z.infer<typeof UploadPersonalKnowledgeDocumentResponse>;
export const uploadPersonalKnowledgeDocumentRoute = { method: 'POST', path: '/api/me/knowledge/:base/documents' } as const satisfies ApiRoute;

export const DeletePersonalKnowledgeDocumentResponse = z.object({ removed: z.literal(true) });
export type DeletePersonalKnowledgeDocumentResponse = z.infer<typeof DeletePersonalKnowledgeDocumentResponse>;
export const deletePersonalKnowledgeDocumentRoute = { method: 'DELETE', path: '/api/me/knowledge/:base/documents/:documentId' } as const satisfies ApiRoute;

export const PersonalSearchKnowledgeQuery = SearchKnowledgeQuery;
export const SearchPersonalKnowledgeResponse = z.object({ mode: KnowledgeSearchMode, hits: z.array(KnowledgeHit) });
export type SearchPersonalKnowledgeResponse = z.infer<typeof SearchPersonalKnowledgeResponse>;
export const searchPersonalKnowledgeRoute = { method: 'GET', path: '/api/me/knowledge/:base/search' } as const satisfies ApiRoute;

export const PersonalKnowledgeSourceResponse = z.object({ source: KnowledgeSource });
export type PersonalKnowledgeSourceResponse = z.infer<typeof PersonalKnowledgeSourceResponse>;
export const addPersonalKnowledgeUrlSourceRoute = { method: 'POST', path: '/api/me/knowledge/:base/sources' } as const satisfies ApiRoute;
export const PersonalAddKnowledgeUrlSourceRequest = AddKnowledgeUrlSourceRequest;
export const DeletePersonalKnowledgeSourceResponse = z.object({ removed: z.literal(true), documents: z.number().int().min(0) });
export type DeletePersonalKnowledgeSourceResponse = z.infer<typeof DeletePersonalKnowledgeSourceResponse>;
export const deletePersonalKnowledgeSourceRoute = { method: 'DELETE', path: '/api/me/knowledge/:base/sources/:sourceId' } as const satisfies ApiRoute;
