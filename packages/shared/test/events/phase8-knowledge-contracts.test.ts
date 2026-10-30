import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CreateKnowledgeBaseRequest,
  GetKnowledgeBaseResponse,
  KnowledgeBaseSlug,
  KnowledgeDocument,
  KnowledgeHit,
  SearchKnowledgeQuery,
  UploadKnowledgeDocumentResponse,
  eventRegistry,
  parseEvent,
} from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P8-07/P8-08 (`pnpm test:events`): the five knowledge events (ids, kinds, counts and short codes only: never a document name or its
// text) and the shapes of a document, a hit and the routes' bodies.

const AT = '2026-10-30T08:00:00.000Z';
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};
const base = { schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), baseId: uuid(3), at: AT };

describe('the knowledge events', () => {
  const events = {
    'knowledge.base.created': { type: 'knowledge.base.created', ...base, slug: 'handbook', createdBy: uuid(4) },
    'knowledge.base.deleted': { type: 'knowledge.base.deleted', ...base, slug: 'handbook', documents: 3, deletedBy: uuid(4) },
    'knowledge.document.added': { type: 'knowledge.document.added', ...base, documentId: uuid(5), kind: 'pdf', status: 'indexed', size: 1200, version: 2, replaced: true, chunks: 6, addedBy: uuid(4) },
    'knowledge.document.removed': { type: 'knowledge.document.removed', ...base, documentId: uuid(5), removedBy: uuid(4) },
    'knowledge.base.resynced': { type: 'knowledge.base.resynced', ...base, checked: 5, updated: 1, added: 1, removed: 0, failed: 1, resyncedBy: uuid(4) },
  } as const;

  it.each(Object.entries(events))('%s is registered at version 1 and round-trips', (type, payload) => {
    expect(Object.keys(eventRegistry[type as keyof typeof eventRegistry])).toEqual(['1']);
    expect(parseEvent(payload)).toEqual(payload);
  });

  it.each([
    ['knowledge.base.created', 'slug', { slug: 'Not A Slug' }],
    ['knowledge.base.deleted', 'documents', { documents: -1 }],
    ['knowledge.document.added', 'kind', { kind: 'docx' }],
    ['knowledge.document.added', 'status', { status: 'pending' }],
    ['knowledge.document.added', 'version', { version: 0 }],
    ['knowledge.document.removed', 'documentId', { documentId: 'x' }],
    ['knowledge.base.resynced', 'failed', { failed: 1.5 }],
  ] as const)('%s refuses a bad %s', (type, field, over) => expect(failsAt({ ...events[type], ...over })).toContain(field));

  it('carry ids, kinds and counts only', () => {
    for (const payload of Object.values(events)) {
      const keys = Object.keys(payload);
      expect(keys.filter((k) => /name|text|title|body|content|reason/i.test(k.replace('Id', '')))).toEqual([]);
    }
  });
});

describe('knowledge shapes', () => {
  const doc = {
    id: uuid(5),
    baseId: uuid(3),
    name: 'Refund policy.pdf',
    kind: 'pdf',
    source: 'upload',
    size: 1200,
    shortHash: 'abcdef012345',
    version: 2,
    status: 'indexed',
    reason: null,
    chunkCount: 4,
    repoPath: 'knowledge/handbook/refund-policy.md',
    indexedAt: AT,
    updatedAt: AT,
  };
  it('a document round-trips and its hash is the first twelve hex characters', () => {
    expect(KnowledgeDocument.parse(doc)).toEqual(doc);
    expect(() => KnowledgeDocument.parse({ ...doc, shortHash: 'abc' })).toThrow();
    expect(() => KnowledgeDocument.parse({ ...doc, version: 0 })).toThrow();
    expect(UploadKnowledgeDocumentResponse.parse({ outcome: 'unchanged', document: doc }).outcome).toBe('unchanged');
    expect(() => UploadKnowledgeDocumentResponse.parse({ outcome: 'merged', document: doc })).toThrow();
  });

  it('a hit says which document, which version and where, and whether the source changed', () => {
    const hit = { chunkId: uuid(6), baseSlug: 'handbook', documentId: uuid(5), documentName: 'Refund policy.pdf', documentKind: 'pdf', version: 1, currentVersion: 2, sourceChanged: true, section: 'Page 3', offsetStart: 10, offsetEnd: 90, text: 'Refunds are paid within 14 days.', score: 0.8, repoPath: null };
    expect(KnowledgeHit.parse(hit)).toEqual(hit);
    expect(() => KnowledgeHit.parse({ ...hit, score: 1.2 })).toThrow();
  });

  it('the bodies are strict and the base short name is a slug', () => {
    expect(CreateKnowledgeBaseRequest.parse({ slug: 'handbook', name: 'Handbook' })).toEqual({ slug: 'handbook', name: 'Handbook' });
    expect(() => CreateKnowledgeBaseRequest.parse({ slug: 'handbook', extra: 1 })).toThrow();
    expect(KnowledgeBaseSlug.safeParse('-bad').success).toBe(false);
    expect(KnowledgeBaseSlug.safeParse('a'.repeat(64)).success).toBe(false);
    expect(SearchKnowledgeQuery.parse({ q: ' refunds ' })).toEqual({ q: 'refunds', limit: 5 });
    expect(SearchKnowledgeQuery.safeParse({ q: 'a' }).success).toBe(false);
    expect(GetKnowledgeBaseResponse.safeParse({}).success).toBe(false);
  });
});
