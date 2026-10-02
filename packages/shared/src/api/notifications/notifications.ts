import { z } from 'zod';
import { Page } from '../../common/page.ts';
import { Notification, NotificationPrefs } from '../../entities/notification.ts';
import { NotificationId } from '../../ids.ts';

// The notifications inbox (SPEC section 3, PLAN P3-09). Every route acts on the caller's own rows; a bot has no inbox (403).

/** Newest first, keyset by notification id (uuid v7 sorts by time): `cursor` is the `nextCursor` of the previous page. */
export const ListNotificationsQuery = z.object({
  cursor: NotificationId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** `true` lists unread items only. */
  unread: z.enum(['true', 'false']).default('false'),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuery>;
export const ListNotificationsResponse = Page(Notification);
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponse>;
export const listNotificationsRoute = { method: 'GET', path: '/api/notifications' } as const;

/** What the bell needs: how many are unread. */
export const GetNotificationSummaryResponse = z.object({ unreadCount: z.number().int().nonnegative() });
export type GetNotificationSummaryResponse = z.infer<typeof GetNotificationSummaryResponse>;
export const getNotificationSummaryRoute = { method: 'GET', path: '/api/notifications/summary' } as const;

/** Mark some notifications read (1 to 100 ids; an id that is not yours or already read is skipped), or all of them. */
export const MarkNotificationsReadRequest = z.union([
  z.strictObject({ ids: z.array(NotificationId).min(1).max(100) }),
  z.strictObject({ all: z.literal(true) }),
]);
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequest>;
/** `updated` is how many changed from unread to read; `unreadCount` is what is left. */
export const MarkNotificationsReadResponse = z.object({ updated: z.number().int().nonnegative(), unreadCount: z.number().int().nonnegative() });
export type MarkNotificationsReadResponse = z.infer<typeof MarkNotificationsReadResponse>;
export const markNotificationsReadRoute = { method: 'POST', path: '/api/notifications/mark-read' } as const;

export const GetNotificationPrefsResponse = NotificationPrefs;
export type GetNotificationPrefsResponse = z.infer<typeof GetNotificationPrefsResponse>;
export const getNotificationPrefsRoute = { method: 'GET', path: '/api/notifications/prefs' } as const;

/** Replaces the whole document: send what `GET` returned, changed. Duplicate muted channels are folded into one. */
export const UpdateNotificationPrefsRequest = z.strictObject({
  mention: z.strictObject({ inApp: z.boolean(), browser: z.boolean() }),
  reply: z.strictObject({ inApp: z.boolean(), browser: z.boolean() }),
  dm: z.strictObject({ inApp: z.boolean(), browser: z.boolean() }),
  mutedChannels: NotificationPrefs.shape.mutedChannels,
});
export type UpdateNotificationPrefsRequest = z.infer<typeof UpdateNotificationPrefsRequest>;
export const UpdateNotificationPrefsResponse = NotificationPrefs;
export type UpdateNotificationPrefsResponse = z.infer<typeof UpdateNotificationPrefsResponse>;
export const updateNotificationPrefsRoute = { method: 'PUT', path: '/api/notifications/prefs' } as const;

// Live pushes (WebSocket envelope `{ type, id, payload }`, see ctx.realtime.pushToPerson).

/**
 * A notification was made for the signed-in person. Also sent when a lower-ranked one (a reply, a dm) became a mention: upsert by `id`
 * (a new id raises the badge by one; `GET /api/notifications/summary` is the authoritative count).
 */
export const NotificationCreatedPush = z.object({
  notification: Notification,
  /** The person's `browser` setting for this kind, so the client can raise an operating-system alert without another request. */
  browser: z.boolean(),
});
export type NotificationCreatedPush = z.infer<typeof NotificationCreatedPush>;
export const notificationCreatedPushType = 'notification.created' as const;

/** Notifications were marked read (in another tab or device): `ids` when some, `all: true` when every one. */
export const NotificationReadPush = z.object({
  ids: z.array(NotificationId),
  all: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationReadPush = z.infer<typeof NotificationReadPush>;
export const notificationReadPushType = 'notification.read' as const;
