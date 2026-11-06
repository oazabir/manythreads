import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { InboxItemId, InboxKind, InboxOrigin, InboxState } from '../entities/inbox.ts';
import { PersonId, WorkspaceId } from '../ids.ts';

/**
 * An item of a person's own inbox moved (P20-04): dropped (`queued`), held, filed, failed or discarded. Ids, the state, the origin, the kind and the size only:
 * never the name or the text. A team's inbox has its own events (`memory.item.*`, which carry a team); a Personal item has no team, so it has this one.
 */
export const MemoryPersonalItemChangedEvent = z.object({
  type: z.literal('memory.personal_item.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  itemId: InboxItemId,
  state: InboxState,
  origin: InboxOrigin,
  kind: InboxKind,
  size: z.number().int().min(0),
  /** Whether the same bytes were already in the inbox, so nothing was queued. */
  duplicate: z.boolean(),
  at: IsoDateTime,
});
export type MemoryPersonalItemChangedEvent = z.infer<typeof MemoryPersonalItemChangedEvent>;
