import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { KnowledgeBaseId, KnowledgeBaseSlug } from '../entities/knowledge.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** A team lead or admin created a knowledge base (PLAN P8-07). Ids and the base's short code only: never a document, a name or any text. */
export const KnowledgeBaseCreatedEvent = z.object({
  type: z.literal('knowledge.base.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  baseId: KnowledgeBaseId,
  slug: KnowledgeBaseSlug,
  createdBy: ActorId,
  at: IsoDateTime,
});
export type KnowledgeBaseCreatedEvent = z.infer<typeof KnowledgeBaseCreatedEvent>;
