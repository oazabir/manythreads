import { z } from 'zod';
import { ImportSource } from '../api/import/index.ts';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * Someone signed in with the email of an imported placeholder and took over the messages written under it (PLAN P14-13). The database writes the
 * event in the same statement as the change. It names the new owner, the placeholder's actor and how many messages moved; never an email address or a name.
 */
export const ImportPersonClaimedEvent = z.object({
  type: z.literal('import.person.claimed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  source: ImportSource,
  personId: PersonId,
  placeholderActorId: ActorId,
  messages: z.number().int().nonnegative(),
  at: IsoDateTime,
});
export type ImportPersonClaimedEvent = z.infer<typeof ImportPersonClaimedEvent>;
