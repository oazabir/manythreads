import { z } from 'zod';
import { ChannelId, LaterItemId, MessageId, PersonId, WorkspaceId } from '../ids.ts';

/**
 * A person's reminder time came and the message is still there for them to read. The reminders plugin writes it once per item, in the same
 * transaction that marks the item fired; the notifications plugin turns it into a notification. The payload names the person and the message,
 * never its text. No `teamId`: only workspace admins read it from the event log.
 */
export const RemindersReminderDueEvent = z.object({
  type: z.literal('reminders.reminder.due'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  personId: PersonId,
  itemId: LaterItemId,
  messageId: MessageId,
  channelId: ChannelId,
});
export type RemindersReminderDueEvent = z.infer<typeof RemindersReminderDueEvent>;
