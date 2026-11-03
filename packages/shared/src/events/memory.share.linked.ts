import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ShareId, ShareLinkEnd, ShareLinkId, ShareLinkState } from '../entities/share.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/**
 * A link between a share and one destination team changed state (PLAN P8-24): the destination's lead accepted it, or paused, resumed or ended it, or
 * the sending file dropped the destination. `teamId` is the sending team. Ids and codes only.
 */
export const MemoryShareLinkedEvent = z.object({
  type: z.literal('memory.share.linked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  destTeamId: TeamId,
  shareId: ShareId,
  linkId: ShareLinkId,
  from: ShareLinkState,
  to: ShareLinkState,
  endedReason: ShareLinkEnd.nullable(),
  changedBy: ActorId.nullable(),
  at: IsoDateTime,
});
export type MemoryShareLinkedEvent = z.infer<typeof MemoryShareLinkedEvent>;
