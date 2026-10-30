import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { KnowledgeBaseId, KnowledgeDocumentId } from '../entities/knowledge.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** A document was taken out of a knowledge base, by a person or by a re-sync that found its file gone from the repo folder (PLAN P8-07). Ids only. */
export const KnowledgeDocumentRemovedEvent = z.object({
  type: z.literal('knowledge.document.removed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  baseId: KnowledgeBaseId,
  documentId: KnowledgeDocumentId,
  removedBy: ActorId,
  at: IsoDateTime,
});
export type KnowledgeDocumentRemovedEvent = z.infer<typeof KnowledgeDocumentRemovedEvent>;
