import { z } from 'zod';
import { REMINDER_TEXT_MAX, ReminderState, ReminderTargetKind } from '../../entities/reminder.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId, PersonId, ReminderId } from '../../ids.ts';

// Reminders made with `/remind` (PLAN P14-04, plugin `reminders`; docs/plugins/reminders.md). Every route acts on the caller's own reminders (a bot has
// none, and nobody else's are ever visible, an admin's included). The browser works out the exact time in the person's own time zone.

/** What a reminder says: one line, 1 to 500 characters, no line breaks. */
export const ReminderText = z
  .string()
  .trim()
  .min(1)
  .max(REMINDER_TEXT_MAX)
  .refine((v) => !v.includes('\n') && !v.includes('\r'), { message: 'A reminder is one line' });

/**
 * Who to remind. `person` also names the channel the person was asked in (`channelId`): both must be able to read it, so a reminder can never carry
 * a conversation to someone who may not see it. `channel` posts in that channel at the time, which the maker must be allowed to do then.
 */
export const ReminderTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('me') }),
  z.strictObject({ kind: z.literal('person'), personId: PersonId, channelId: ChannelId }),
  z.strictObject({ kind: z.literal('channel'), channelId: ChannelId }),
]);
export type ReminderTarget = z.infer<typeof ReminderTarget>;

/** One reminder of the caller. `refusedReason` is set exactly when `state` is `refused`. A name is null when the caller can no longer read it. */
export const Reminder = z.object({
  id: ReminderId,
  targetKind: ReminderTargetKind,
  person: z.object({ id: PersonId, name: z.string() }).nullable(),
  channel: z.object({ id: ChannelId, name: z.string() }).nullable(),
  text: z.string().min(1).max(REMINDER_TEXT_MAX),
  remindAt: IsoDateTime,
  state: ReminderState,
  refusedReason: z.string().nullable(),
  createdAt: IsoDateTime,
  sentAt: IsoDateTime.nullable(),
});
export type Reminder = z.infer<typeof Reminder>;

export const ReminderPathParams = z.object({ reminderId: ReminderId });

export const ListRemindersQuery = z.object({ state: z.enum(['pending', 'history']).default('pending') });
export type ListRemindersQuery = z.infer<typeof ListRemindersQuery>;
/** `pending`: those waiting, soonest first. `history`: sent, cancelled and refused ones of the last 30 days, newest first. */
export const ListRemindersResponse = z.object({ items: z.array(Reminder), pendingCount: z.number().int().nonnegative() });
export type ListRemindersResponse = z.infer<typeof ListRemindersResponse>;
export const listRemindersRoute = { method: 'GET', path: '/api/reminders' } as const;

export const CreateReminderRequest = z.strictObject({ target: ReminderTarget, text: ReminderText, remindAt: IsoDateTime });
export type CreateReminderRequest = z.infer<typeof CreateReminderRequest>;
export const CreateReminderResponse = Reminder;
export type CreateReminderResponse = z.infer<typeof CreateReminderResponse>;
export const createReminderRoute = { method: 'POST', path: '/api/reminders' } as const;

/** Cancel a waiting reminder. Cancelling twice, or one already sent, is fine: `cancelled` is false then. */
export const CancelReminderResponse = z.object({ cancelled: z.boolean() });
export type CancelReminderResponse = z.infer<typeof CancelReminderResponse>;
export const cancelReminderRoute = { method: 'DELETE', path: '/api/reminders/:reminderId' } as const;
