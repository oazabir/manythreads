import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BotServerName } from '../entities/bot-server.ts';
import { ActorId, BotServerId, WorkspaceId } from '../ids.ts';

/**
 * Something changed about an enrolled server (P26-13, docs/plans/agents-anywhere.md §5.5). Content-blind: the event says which server (by id and name) and what kind of
 * change, never a code, a key, an address or the machine's facts. `actorId` is the admin who did it, or null when the server itself did (it enrolled or connected).
 *   code_minted    an admin made a one-time enrolment code
 *   enrolled       the installer redeemed a code and was given a bridge key
 *   connected      the bridge opened its connection
 *   disconnected   the connection ended (dropped, replaced or cut)
 *   key_rotated    an admin made a new bridge key
 *   removed        an admin removed the server, or the installer's uninstall did
 */
export const BotServerChange = z.enum(['code_minted', 'enrolled', 'connected', 'disconnected', 'key_rotated', 'removed']);
export type BotServerChange = z.infer<typeof BotServerChange>;

export const BotServerChangedEvent = z.object({
  type: z.literal('bot_server.server.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  serverId: BotServerId,
  name: BotServerName,
  change: BotServerChange,
  actorId: ActorId.nullable(),
  at: IsoDateTime,
});
export type BotServerChangedEvent = z.infer<typeof BotServerChangedEvent>;
