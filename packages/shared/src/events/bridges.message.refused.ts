import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BridgeProvider, BridgeRefusalReason } from '../entities/bridge.ts';
import { BridgeAccountId, WorkspaceId } from '../ids.ts';

/** Inbound chat traffic was refused (Bundle D, P16-09): a message from someone who is not linked, from an account that is off, or with a bad signature. Counted, at most one per minute per account and reason; never the text or the sender. */
export const BridgesMessageRefusedEvent = z.object({
  type: z.literal('bridges.message.refused'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  accountId: BridgeAccountId,
  provider: BridgeProvider,
  reason: BridgeRefusalReason,
  count: z.number().int().min(1),
  at: IsoDateTime,
});
export type BridgesMessageRefusedEvent = z.infer<typeof BridgesMessageRefusedEvent>;
