import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MessageId, NotificationId } from '../ids.ts';
import { ChannelKind } from './channel.ts';

// Phase 3 notifications (PLAN.md A.3 `notifications`, `notification_prefs`; plugin `notifications`, P3-09).

/** Why a person is told: named in a message, a reply in a thread they follow, or a direct message. Matches the SQL CHECK exactly. */
export const NotificationKind = z.enum(['mention', 'reply', 'dm']);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** What `refId` points at. Messages today; the column is generic so later kinds (approvals, tasks) need no migration. */
export const NotificationRefType = z.enum(['message']);
export type NotificationRefType = z.infer<typeof NotificationRefType>;

/**
 * One item of a person's inbox. `refId` is the message to open (with `channelId`, and `threadRootId` when it is a reply, so a click can
 * land on the message or open the thread panel). `actorName` and `preview` are snapshots taken when the notification was made; the
 * preview is plain text, one line, at most 140 characters.
 */
export const Notification = z.object({
  id: NotificationId,
  kind: NotificationKind,
  refType: NotificationRefType,
  refId: MessageId,
  channelId: ChannelId,
  /** `dev` for a channel; null for a direct message or other conversation without a name. */
  channelName: z.string().nullable(),
  channelKind: ChannelKind,
  threadRootId: MessageId.nullable(),
  actorId: ActorId,
  actorName: z.string(),
  preview: z.string().max(280),
  readAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Notification = z.infer<typeof Notification>;

/** How one kind of notification reaches the person. `browser` is read by the web client: it raises an operating-system alert from the live push. */
export const NotificationDelivery = z.object({ inApp: z.boolean(), browser: z.boolean() });
export type NotificationDelivery = z.infer<typeof NotificationDelivery>;

export const MAX_MUTED_CHANNELS = 500;

/** A person's notification settings; the stored document and what the API serves (defaults when never saved). */
export const NotificationPrefs = z.object({
  mention: NotificationDelivery,
  reply: NotificationDelivery,
  dm: NotificationDelivery,
  /** Channels that never notify this person (on top of a channel membership they muted). */
  mutedChannels: z.array(ChannelId).max(MAX_MUTED_CHANNELS),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

/** What a person gets before they change anything: everything in the app, no operating-system alerts until they allow them. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  mention: { inApp: true, browser: false },
  reply: { inApp: true, browser: false },
  dm: { inApp: true, browser: false },
  mutedChannels: [],
};
