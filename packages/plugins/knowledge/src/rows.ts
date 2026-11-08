import { KnowledgeBase, KnowledgeDocument, KnowledgeSource, PersonalKnowledgeBase, type KnowledgeDocumentKind } from '@manythreads/shared';

// Database rows and how they become the API's shapes.

export type BaseRow = {
  id: string;
  team_id: string | null;
  owner_person_id: string | null;
  slug: string;
  name: string;
  status: 'empty' | 'ready' | 'attention';
  created_at: Date;
  document_count: number;
  indexed_count: number;
  failed_count: number;
  chunk_count: number;
  last_indexed_at: Date | null;
}

/** A base with its counts; `WHERE` and ordering are the caller's. Counts run under the caller's own row-level security. */
export const BASE_SELECT = `
  SELECT b.id, b.team_id, b.owner_person_id, b.slug, b.name, b.status, b.created_at,
         (SELECT count(*) FROM app.knowledge_documents d WHERE d.base_id = b.id)::int AS document_count,
         (SELECT count(*) FROM app.knowledge_documents d WHERE d.base_id = b.id AND d.status = 'indexed')::int AS indexed_count,
         (SELECT count(*) FROM app.knowledge_documents d WHERE d.base_id = b.id AND d.status = 'failed')::int AS failed_count,
         (SELECT coalesce(sum(d.chunk_count), 0) FROM app.knowledge_documents d WHERE d.base_id = b.id)::int AS chunk_count,
         (SELECT max(d.indexed_at) FROM app.knowledge_documents d WHERE d.base_id = b.id) AS last_indexed_at
    FROM app.knowledge_bases b`;

export const repoFolderOf = (slug: string): string => `knowledge/${slug}`;

export function toBase(row: BaseRow): KnowledgeBase {
  if (row.team_id === null) throw new Error('toBase was given a base of a person; use toPersonalBase');
  return KnowledgeBase.parse({
    id: row.id,
    teamId: row.team_id,
    slug: row.slug,
    name: row.name,
    state: row.status,
    documentCount: row.document_count,
    indexedCount: row.indexed_count,
    failedCount: row.failed_count,
    chunkCount: row.chunk_count,
    lastIndexedAt: row.last_indexed_at ? row.last_indexed_at.toISOString() : null,
    repoFolder: repoFolderOf(row.slug),
    createdAt: row.created_at.toISOString(),
  });
}

/** A base of a person, as the API shapes it: no team, no repo folder, and the space it lives in. */
export function toPersonalBase(row: BaseRow): PersonalKnowledgeBase {
  if (row.owner_person_id === null) throw new Error('toPersonalBase was given a base of a team');
  return PersonalKnowledgeBase.parse({
    id: row.id,
    personId: row.owner_person_id,
    space: `person:${row.owner_person_id}`,
    slug: row.slug,
    name: row.name,
    state: row.status,
    documentCount: row.document_count,
    indexedCount: row.indexed_count,
    failedCount: row.failed_count,
    chunkCount: row.chunk_count,
    lastIndexedAt: row.last_indexed_at ? row.last_indexed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  });
}

export type DocRow = {
  id: string;
  base_id: string;
  team_id: string | null;
  source_id: string;
  source_kind: 'upload' | 'repo' | 'url' | 'connector';
  name: string;
  slug: string;
  kind: KnowledgeDocumentKind;
  size: string | number;
  sha256: string;
  version: number;
  status: 'indexed' | 'failed';
  reason: string | null;
  blob_key: string | null;
  repo_path: string | null;
  repo_sha: string | null;
  chunk_count: number;
  indexed_at: Date | null;
  updated_at: Date;
}

export const DOC_COLUMNS = `d.id, d.base_id, d.team_id, d.source_id, s.kind AS source_kind, d.name, d.slug, d.kind, d.size, d.sha256, d.version, d.status,
  d.reason, d.blob_key, d.repo_path, d.repo_sha, d.chunk_count, d.indexed_at, d.updated_at`;
export const DOC_FROM = `app.knowledge_documents d JOIN app.knowledge_sources s ON s.id = d.source_id`;

export function toDocument(row: DocRow): KnowledgeDocument {
  return KnowledgeDocument.parse({
    id: row.id,
    baseId: row.base_id,
    name: row.name,
    kind: row.kind,
    source: row.source_kind,
    size: Number(row.size),
    shortHash: row.sha256.slice(0, 12),
    version: row.version,
    status: row.status,
    reason: row.reason,
    chunkCount: row.chunk_count,
    repoPath: row.repo_path,
    indexedAt: row.indexed_at ? row.indexed_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
  });
}

export type SourceRow = {
  id: string;
  base_id: string;
  kind: 'upload' | 'repo' | 'url';
  url: string | null;
  label: string | null;
  sync_minutes: number | null;
  last_synced_at: Date | null;
  error: string | null;
}
export const SOURCE_COLUMNS = 's.id, s.base_id, s.kind, s.url, s.label, s.sync_minutes, s.last_synced_at, s.error';

export function toSource(row: SourceRow): KnowledgeSource {
  return KnowledgeSource.parse({
    id: row.id,
    kind: row.kind,
    url: row.url,
    label: row.label,
    syncMinutes: row.sync_minutes,
    lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
    error: row.error,
  });
}
