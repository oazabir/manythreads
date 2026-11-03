import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxItemId } from '../entities/inbox.ts';
import { ShareDeliveryId, ShareId, ShareRunId, ShareSlug } from '../entities/share.ts';
import { TeamId, WorkspaceId } from '../ids.ts';

/**
 * A digest was handed to a team that accepted it (PLAN P8-24): it is now an item in the receiving team's memory inbox. `teamId` is the sending team,
 * `destTeamId` the receiving one. Announced once per delivery (handing the same digest to the same team again writes nothing and says nothing). Ids and
 * counts only: never a path, a title or any text of a concept.
 */
export const MemoryDigestDeliveredEvent = z.object({
  type: z.literal('memory.digest.delivered'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  destTeamId: TeamId,
  shareId: ShareId,
  slug: ShareSlug,
  runId: ShareRunId,
  deliveryId: ShareDeliveryId,
  itemId: InboxItemId.nullable(),
  files: z.number().int().min(0),
  bytes: z.number().int().min(0),
  at: IsoDateTime,
});
export type MemoryDigestDeliveredEvent = z.infer<typeof MemoryDigestDeliveredEvent>;
