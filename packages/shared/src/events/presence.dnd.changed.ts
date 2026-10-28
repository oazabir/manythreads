import { z } from 'zod';
import { PersonId, WorkspaceId } from '../ids.ts';
import { IsoDateTime } from '../common/time.ts';

/**
 * A person changed their Do not disturb settings (switched it on or off, paused notifications, or edited the weekly schedule). The payload
 * says whether it is on right now and when it ends; the settings themselves stay private. The notifications plugin listens to deliver what
 * it held while the person was away. No `teamId`: only workspace admins read it from the event log.
 */
export const PresenceDndChangedEvent = z.object({
  type: z.literal('presence.dnd.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  active: z.boolean(),
  until: IsoDateTime.nullable(),
});
export type PresenceDndChangedEvent = z.infer<typeof PresenceDndChangedEvent>;
