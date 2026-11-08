import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BridgeProvider } from '../entities/bridge.ts';
import { ActorId, BridgeAccountId, BridgeLinkId, ChannelId, TeamId, WorkspaceId } from '../ids.ts';

/** A channel was taken off an outside chat (Bundle D, P16-09): by a lead or admin, or by the platform because the channel became private or was archived (`actorId` null). */
export const BridgesChannelUnlinkedEvent = z.object({
  type: z.literal('bridges.channel.unlinked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  channelId: ChannelId,
  accountId: BridgeAccountId,
  linkId: BridgeLinkId,
  provider: BridgeProvider,
  actorId: ActorId.nullable(),
  reason: z.enum(['person', 'channel_private', 'channel_archived', 'account_removed']),
  at: IsoDateTime,
});
export type BridgesChannelUnlinkedEvent = z.infer<typeof BridgesChannelUnlinkedEvent>;
