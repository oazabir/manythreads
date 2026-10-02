import { z } from 'zod';
import { MessageId, PersonId, WorkspaceId } from '../ids.ts';
import { ReadTargetType } from '../entities/read-state.ts';

/**
 * Unread counts changed for one target: someone posted (`posted`, one change per recipient), a person read up to a message
 * (`read`) or followed or unfollowed it (`followed`). The type is `reading.state.changed`, not `read_state.changed`: event
 * types need three segments (domain.noun.verb). Written in the workspace (no `teamId`), so only workspace admins read it from the event log;
 * the person's own sockets get the same change pushed live.
 */
export const ReadingStateChangedEvent = z.object({
  type: z.literal('reading.state.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  targetType: ReadTargetType,
  targetId: z.uuid(),
  reason: z.enum(['posted', 'read', 'followed']),
  changes: z
    .array(
      z.object({
        personId: PersonId,
        lastReadId: MessageId.nullable(),
        unreadCount: z.number().int().nonnegative(),
        followed: z.boolean(),
      }),
    )
    .min(1),
});
export type ReadingStateChangedEvent = z.infer<typeof ReadingStateChangedEvent>;
