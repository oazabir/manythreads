import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, TeamId, WorkspaceId } from '../ids.ts';

/** A bot's pairing token (its credential for the stable MCP endpoint) was rotated: who did it and how many old tokens that turned off. Never a token. */
export const BotsPairingRotatedEvent = z.object({
  type: z.literal('bots.pairing.rotated'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: z.uuid(),
  actorId: ActorId,
  revoked: z.number().int().min(0),
  at: IsoDateTime,
});
export type BotsPairingRotatedEvent = z.infer<typeof BotsPairingRotatedEvent>;
