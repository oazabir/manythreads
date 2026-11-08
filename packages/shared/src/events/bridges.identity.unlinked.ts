import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { BridgeProvider } from '../entities/bridge.ts';
import { ActorId, BridgeAccountId, PersonId, WorkspaceId } from '../ids.ts';

/** A person's link to a chat user ended (Bundle D, P16-09): they unlinked, typed /unlink in the chat, an admin removed it, or they left the workspace. */
export const BridgesIdentityUnlinkedEvent = z.object({
  type: z.literal('bridges.identity.unlinked'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  accountId: BridgeAccountId,
  provider: BridgeProvider,
  personId: PersonId,
  how: z.enum(['person', 'chat_command', 'admin', 'offboarded']),
  actorId: ActorId.nullable(),
  at: IsoDateTime,
});
export type BridgesIdentityUnlinkedEvent = z.infer<typeof BridgesIdentityUnlinkedEvent>;
