import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { KnowledgeBaseId, KnowledgeBaseSlug } from '../entities/knowledge.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** A knowledge base was removed with its documents and passages; the converted files in the team repo are left for the team to delete (PLAN P8-07). */
export const KnowledgeBaseDeletedEvent = z.object({
  type: z.literal('knowledge.base.deleted'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  baseId: KnowledgeBaseId,
  slug: KnowledgeBaseSlug,
  documents: z.number().int().min(0),
  deletedBy: ActorId,
  at: IsoDateTime,
});
export type KnowledgeBaseDeletedEvent = z.infer<typeof KnowledgeBaseDeletedEvent>;
