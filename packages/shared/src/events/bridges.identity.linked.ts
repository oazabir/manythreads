import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BridgeProvider } from '../entities/bridge.ts';
import { BridgeAccountId, PersonId, WorkspaceId } from '../ids.ts';

/** A person proved a chat user is theirs with a code (Bundle D, P16-09). Ids only; the chat user's id and name are not part of it. */
export const BridgesIdentityLinkedEvent = z.object({
  type: z.literal('bridges.identity.linked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  accountId: BridgeAccountId,
  provider: BridgeProvider,
  personId: PersonId,
  at: IsoDateTime,
});
export type BridgesIdentityLinkedEvent = z.infer<typeof BridgesIdentityLinkedEvent>;
