import { z } from 'zod';
import { DigestDelayMinutes, DigestSettings } from '../../entities/notification-digest.ts';

// The email digest (PLAN P14-09). The two settings routes act on the caller's own row. The two unsubscribe routes are the link at the foot of
// every digest: they take no sign-in, the token in the path is the whole credential, and all they can do is turn the digest off for the person
// the token names.

export const GetDigestSettingsResponse = DigestSettings;
export type GetDigestSettingsResponse = z.infer<typeof GetDigestSettingsResponse>;
export const getDigestSettingsRoute = { method: 'GET', path: '/api/notifications/digest' } as const;

/** Both fields are sent every time (send what the GET returned, changed); anything else is refused. */
export const PutDigestSettingsRequest = z.strictObject({ enabled: z.boolean(), delayMinutes: DigestDelayMinutes });
export type PutDigestSettingsRequest = z.infer<typeof PutDigestSettingsRequest>;
export const PutDigestSettingsResponse = DigestSettings;
export type PutDigestSettingsResponse = z.infer<typeof PutDigestSettingsResponse>;
export const putDigestSettingsRoute = { method: 'PUT', path: '/api/notifications/digest' } as const;

/** `GET` shows a page with one button; `POST` turns the digest off (RFC 8058 one-click: the mail program posts `List-Unsubscribe=One-Click`). */
export const digestUnsubscribePath = '/api/notifications/digest/unsubscribe/:token' as const;
export const digestUnsubscribePageRoute = { method: 'GET', path: digestUnsubscribePath } as const;
export const digestUnsubscribeRoute = { method: 'POST', path: digestUnsubscribePath } as const;

/** What the one-click POST answers to a program (a browser form gets a page). */
export const DigestUnsubscribeResponse = z.object({ unsubscribed: z.literal(true) });
export type DigestUnsubscribeResponse = z.infer<typeof DigestUnsubscribeResponse>;
