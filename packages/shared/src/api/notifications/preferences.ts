import { z } from 'zod';
import { ChannelKind } from '../../entities/channel.ts';
import { KEYWORD_MAX_COUNT, NotificationLevel } from '../../entities/notification-level.ts';
import { ChannelId } from '../../ids.ts';

// Notification levels, personal keywords and browser push (PLAN P14-09). Every route acts on the caller's own settings; the workspace default
// is read by every member and changed by a workspace admin.

/** One channel the person has set a level for. Name and kind come from the channel as the person sees it (a DM has no name). */
export const ChannelLevelEntry = z.object({
  channelId: ChannelId,
  channelName: z.string().nullable(),
  channelKind: ChannelKind,
  level: NotificationLevel,
});
export type ChannelLevelEntry = z.infer<typeof ChannelLevelEntry>;

/** `workspaceDefault` is what a team channel gets when the person set nothing; `channels` are the person's own choices, newest change first. */
export const GetNotificationLevelsResponse = z.object({
  workspaceDefault: NotificationLevel,
  channels: z.array(ChannelLevelEntry).max(1000),
});
export type GetNotificationLevelsResponse = z.infer<typeof GetNotificationLevelsResponse>;
export const getNotificationLevelsRoute = { method: 'GET', path: '/api/notifications/levels' } as const;

export const PutChannelLevelParams = z.object({ channelId: ChannelId });
export type PutChannelLevelParams = z.infer<typeof PutChannelLevelParams>;
/** `level: null` takes the person's own choice away, so the channel follows the default again. */
export const PutChannelLevelRequest = z.strictObject({ level: NotificationLevel.nullable() });
export type PutChannelLevelRequest = z.infer<typeof PutChannelLevelRequest>;
/** `level` is the person's own choice (null: none); `effective` is the level that applies now. */
export const PutChannelLevelResponse = z.object({ channelId: ChannelId, level: NotificationLevel.nullable(), effective: NotificationLevel });
export type PutChannelLevelResponse = z.infer<typeof PutChannelLevelResponse>;
export const putChannelLevelRoute = { method: 'PUT', path: '/api/notifications/levels/:channelId' } as const;

/** A workspace admin sets the level every team channel starts with. */
export const PutWorkspaceLevelRequest = z.strictObject({ level: NotificationLevel });
export type PutWorkspaceLevelRequest = z.infer<typeof PutWorkspaceLevelRequest>;
export const PutWorkspaceLevelResponse = z.object({ workspaceDefault: NotificationLevel });
export type PutWorkspaceLevelResponse = z.infer<typeof PutWorkspaceLevelResponse>;
export const putWorkspaceLevelRoute = { method: 'PUT', path: '/api/notifications/workspace-level' } as const;

/** The person's keywords in their stored form (lower case, single spaces). */
export const NotificationKeywords = z.object({ keywords: z.array(z.string().min(1).max(80)).max(KEYWORD_MAX_COUNT) });
export type NotificationKeywords = z.infer<typeof NotificationKeywords>;
export const GetNotificationKeywordsResponse = NotificationKeywords;
export type GetNotificationKeywordsResponse = z.infer<typeof GetNotificationKeywordsResponse>;
export const getNotificationKeywordsRoute = { method: 'GET', path: '/api/notifications/keywords' } as const;

/** Replaces the whole list. Each word or phrase is lower-cased and tidied; duplicates fold into one; a bad one answers 400 with the reason. */
export const PutNotificationKeywordsRequest = z.strictObject({ keywords: z.array(z.string().max(200)).max(KEYWORD_MAX_COUNT * 2) });
export type PutNotificationKeywordsRequest = z.infer<typeof PutNotificationKeywordsRequest>;
export const PutNotificationKeywordsResponse = NotificationKeywords;
export type PutNotificationKeywordsResponse = z.infer<typeof PutNotificationKeywordsResponse>;
export const putNotificationKeywordsRoute = { method: 'PUT', path: '/api/notifications/keywords' } as const;

// Browser push ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether this server can send browser push (it has its own signing keys) and how many browsers of the caller are signed up. `publicKey` is the
 * server's public signing key in URL-safe base64, which the browser needs to subscribe; null when push is not set up.
 */
export const GetPushStateResponse = z.object({
  available: z.boolean(),
  publicKey: z.string().nullable(),
  subscriptions: z.number().int().nonnegative(),
});
export type GetPushStateResponse = z.infer<typeof GetPushStateResponse>;
export const getPushStateRoute = { method: 'GET', path: '/api/notifications/push' } as const;

/** What a browser's `PushSubscription.toJSON()` holds. The endpoint must be an https address of a push service the server trusts. */
export const SubscribePushRequest = z.strictObject({
  endpoint: z.string().min(12).max(2048),
  keys: z.strictObject({ p256dh: z.string().min(40).max(200), auth: z.string().min(10).max(100) }),
  /** A short label for the browser (shown when listing devices); optional. */
  label: z.string().max(80).optional(),
});
export type SubscribePushRequest = z.infer<typeof SubscribePushRequest>;
export const SubscribePushResponse = z.object({ subscriptions: z.number().int().nonnegative() });
export type SubscribePushResponse = z.infer<typeof SubscribePushResponse>;
export const subscribePushRoute = { method: 'POST', path: '/api/notifications/push/subscribe' } as const;

export const UnsubscribePushRequest = z.strictObject({ endpoint: z.string().min(12).max(2048) });
export type UnsubscribePushRequest = z.infer<typeof UnsubscribePushRequest>;
export const UnsubscribePushResponse = z.object({ subscriptions: z.number().int().nonnegative() });
export type UnsubscribePushResponse = z.infer<typeof UnsubscribePushResponse>;
export const unsubscribePushRoute = { method: 'POST', path: '/api/notifications/push/unsubscribe' } as const;

/**
 * What the service worker receives (the decrypted body of a push). It never holds the text of a message from a private channel or a direct
 * message: `body` is then a fixed line. `url` is a path on this site that opens the message.
 */
export const PushPayload = z.object({
  v: z.literal(1),
  title: z.string().max(200),
  body: z.string().max(200),
  /** One alert per notification: a second push with the same tag replaces the first. */
  tag: z.string().max(80),
  url: z.string().max(300),
  notificationId: z.string().max(80),
});
export type PushPayload = z.infer<typeof PushPayload>;
