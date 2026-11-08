import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BridgeProvider, BridgeStatus } from '../entities/bridge.ts';
import { ActorId, BridgeAccountId, WorkspaceId } from '../ids.ts';

/** A chat app account was made, renamed, switched, given credentials or removed (Bundle D, P16-09). Never a credential or the account's handle. */
export const BridgesAccountChangedEvent = z.object({
  type: z.literal('bridges.account.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  accountId: BridgeAccountId,
  provider: BridgeProvider,
  change: z.enum(['created', 'updated', 'switched', 'credential_set', 'deleted']),
  status: BridgeStatus,
  actorId: ActorId.nullable(),
  at: IsoDateTime,
});
export type BridgesAccountChangedEvent = z.infer<typeof BridgesAccountChangedEvent>;
