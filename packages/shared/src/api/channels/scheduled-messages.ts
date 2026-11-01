import { z } from 'zod';
import { Message } from '../../entities/message.ts';
import { ScheduledMessageState } from '../../entities/scheduled-message.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId, MessageId, ScheduledMessageId } from '../../ids.ts';

// Scheduled send (PLAN P14-05, plugin `channels`; docs/plugins/channels.md). A person schedules a message for a channel (or a thread of it); a job
// posts it as that person at the chosen time, after checking again that they may still post there. Every route acts on the caller's own
// scheduled messages (a bot has none, and nobody else's are ever visible, an admin's included).

/** One scheduled message of the caller. `refusedReason` is set exactly when `state` is `refused`: why the post was not made. */
export const ScheduledMessage = z.object({
  id: ScheduledMessageId,
  channelId: ChannelId,
  /** The first message of the thread this is a reply to; null for a message of the channel itself. */
  threadRootId: MessageId.nullable(),
  body: Message.shape.body,
  sendAt: IsoDateTime,
  state: ScheduledMessageState,
  refusedReason: z.string().nullable(),
  refusedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type ScheduledMessage = z.infer<typeof ScheduledMessage>;

export const ScheduledChannelPathParams = z.object({ channelId: ChannelId });
export const ScheduledItemPathParams = z.object({ channelId: ChannelId, scheduledId: ScheduledMessageId });

/**
 * The caller's scheduled and refused messages in one channel (threads included), soonest first. Needs no right to read the channel: a message that
 * could not be sent because the author lost access must stay findable and removable.
 */
export const ListScheduledResponse = z.object({ items: z.array(ScheduledMessage) });
export type ListScheduledResponse = z.infer<typeof ListScheduledResponse>;
export const listScheduledRoute = { method: 'GET', path: '/api/channels/:channelId/scheduled-messages' } as const;

/** Every scheduled and refused message of the caller, in any channel (most recent 200), soonest first: the "Not sent" list, which needs no open channel. */
export const listAllScheduledRoute = { method: 'GET', path: '/api/scheduled-messages' } as const;

/** Schedule a message. `sendAt` is an exact moment (the browser works it out in the person's own time zone). Text only. */
export const ScheduleMessageRequest = z.strictObject({
  body: Message.shape.body,
  sendAt: IsoDateTime,
  threadRootId: MessageId.nullish(),
});
export type ScheduleMessageRequest = z.infer<typeof ScheduleMessageRequest>;
export const ScheduleMessageResponse = ScheduledMessage;
export type ScheduleMessageResponse = z.infer<typeof ScheduleMessageResponse>;
export const scheduleMessageRoute = { method: 'POST', path: '/api/channels/:channelId/scheduled-messages' } as const;

/**
 * Change the text, the time, or both. A refused message is scheduled again by this call (its reason is cleared): the new time must be
 * valid, so a refused message whose old time has passed needs a `sendAt`.
 */
export const EditScheduledRequest = z
  .strictObject({ body: Message.shape.body.optional(), sendAt: IsoDateTime.optional() })
  .refine((v) => v.body !== undefined || v.sendAt !== undefined, { message: 'Change the text or the time' });
export type EditScheduledRequest = z.infer<typeof EditScheduledRequest>;
export const EditScheduledResponse = ScheduledMessage;
export type EditScheduledResponse = z.infer<typeof EditScheduledResponse>;
export const editScheduledRoute = { method: 'PATCH', path: '/api/channels/:channelId/scheduled-messages/:scheduledId' } as const;

/** Cancel a scheduled message (or dismiss a refused one). Cancelling twice is fine: `cancelled` is false the second time. */
export const CancelScheduledResponse = z.object({ cancelled: z.boolean() });
export type CancelScheduledResponse = z.infer<typeof CancelScheduledResponse>;
export const cancelScheduledRoute = { method: 'DELETE', path: '/api/channels/:channelId/scheduled-messages/:scheduledId' } as const;
