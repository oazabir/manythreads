import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { KnowledgeBaseId } from '../entities/knowledge.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** Someone asked a knowledge base to re-read its documents (PLAN P8-08): counts of what moved, never a name or text. */
export const KnowledgeBaseResyncedEvent = z.object({
  type: z.literal('knowledge.base.resynced'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  baseId: KnowledgeBaseId,
  checked: z.number().int().min(0),
  updated: z.number().int().min(0),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  failed: z.number().int().min(0),
  resyncedBy: ActorId,
  at: IsoDateTime,
});
export type KnowledgeBaseResyncedEvent = z.infer<typeof KnowledgeBaseResyncedEvent>;
