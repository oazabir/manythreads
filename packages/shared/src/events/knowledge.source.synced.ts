import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { KnowledgeBaseId } from '../entities/knowledge.ts';
import { KnowledgeConnectorProvider, KnowledgeSourceStatus } from '../entities/connector-source.ts';
import { PersonId, TeamId, WorkspaceId } from '../ids.ts';

/** A connector source finished a pass (Bundle D, P16-08): counts of what moved and what was left out, never a document name or text. `skippedLimited` counts documents not everyone on the team can open. */
export const KnowledgeSourceSyncedEvent = z.object({
  type: z.literal('knowledge.source.synced'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  /** The team of a team base; null for a Personal base. */
  teamId: TeamId.nullable(),
  ownerPersonId: PersonId.nullable(),
  baseId: KnowledgeBaseId,
  sourceId: z.uuid(),
  provider: KnowledgeConnectorProvider,
  added: z.number().int().min(0),
  updated: z.number().int().min(0),
  removed: z.number().int().min(0),
  skippedLimited: z.number().int().min(0),
  status: KnowledgeSourceStatus,
  at: IsoDateTime,
});
export type KnowledgeSourceSyncedEvent = z.infer<typeof KnowledgeSourceSyncedEvent>;
