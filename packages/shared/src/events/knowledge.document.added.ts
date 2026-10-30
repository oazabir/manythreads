import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { KnowledgeBaseId, KnowledgeDocumentId, KnowledgeDocumentKind, KnowledgeDocumentStatus } from '../entities/knowledge.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A document entered a knowledge base or changed (PLAN P8-07): a first upload, a new version after the content changed, or a file that could not be read.
 * An upload of content already indexed writes nothing. Ids, the kind, sizes, the version and the outcome only: never the file's name or its text.
 */
export const KnowledgeDocumentAddedEvent = z.object({
  type: z.literal('knowledge.document.added'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  baseId: KnowledgeBaseId,
  documentId: KnowledgeDocumentId,
  kind: KnowledgeDocumentKind,
  status: KnowledgeDocumentStatus,
  size: z.number().int().min(0),
  version: z.number().int().min(1),
  /** True when this made a new version of a document that was already there. */
  replaced: z.boolean(),
  chunks: z.number().int().min(0),
  addedBy: ActorId,
  at: IsoDateTime,
});
export type KnowledgeDocumentAddedEvent = z.infer<typeof KnowledgeDocumentAddedEvent>;
