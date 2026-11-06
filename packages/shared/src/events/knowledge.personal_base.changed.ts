import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { PersonId, WorkspaceId } from '../ids.ts';

/**
 * A knowledge base of a person's own changed (P20-06): created or deleted, or a document added to it or removed from it. Ids and counts only: never the base's
 * name or slug, a document's name or any text. A team's bases have their own events (`knowledge.base.*`, which carry a team).
 */
export const KnowledgePersonalBaseChangedEvent = z.object({
  type: z.literal('knowledge.personal_base.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  baseId: z.uuid(),
  change: z.enum(['created', 'deleted', 'document_added', 'document_removed']),
  /** The documents the base holds after the change. */
  documents: z.number().int().min(0),
  at: IsoDateTime,
});
export type KnowledgePersonalBaseChangedEvent = z.infer<typeof KnowledgePersonalBaseChangedEvent>;
