import { z } from 'zod';
import { PersonId, ReminderId, WorkspaceId } from '../ids.ts';
import { ReminderTargetKind } from '../entities/reminder.ts';

/**
 * A reminder made with `/remind` (P14-04) changed state. `created`: its maker set it; `cancelled`: its maker cancelled it; `sent`: its time came and it
 * was delivered; `refused`: its time came and it could not be delivered (the maker could no longer post there, or the person could no longer read the
 * place). The payload carries ids only: never the text, never the time and never the reason of a refusal (the event log is readable by admins, and a
 * reminder is private to its maker and, once sent, to whom it was sent; the maker reads those from their own row). `recipientId` is the person
 * reminded (the maker for `me`, the other person for `person`, null for `channel`). No `teamId`: only workspace admins read it from the event log.
 */
export const RemindersReminderChangedEvent = z.object({
  type: z.literal('reminders.reminder.changed'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  reminderId: ReminderId,
  creatorId: PersonId,
  targetKind: ReminderTargetKind,
  recipientId: PersonId.nullable(),
  change: z.enum(['created', 'cancelled', 'sent', 'refused']),
});
export type RemindersReminderChangedEvent = z.infer<typeof RemindersReminderChangedEvent>;
