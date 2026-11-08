import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BridgeProvider } from '../entities/bridge.ts';
import { ActorId, BridgeAccountId, BridgeLinkId, ChannelId, TeamId, WorkspaceId } from '../ids.ts';

/** A public channel was joined to an outside chat (Bundle D, P16-09). Ids only; the outside chat's name and id are not part of it. */
export const BridgesChannelLinkedEvent = z.object({
  type: z.literal('bridges.channel.linked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  accountId: BridgeAccountId,
  linkId: BridgeLinkId,
  provider: BridgeProvider,
  actorId: ActorId,
  at: IsoDateTime,
});
export type BridgesChannelLinkedEvent = z.infer<typeof BridgesChannelLinkedEvent>;
