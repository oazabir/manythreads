import { z } from 'zod';
import { AVATAR_PHOTO_MAX_BYTES, Avatar, AvatarPhotoType, BotAvatarPresetId, PersonAvatarPresetId } from '../../entities/avatar.ts';

// Profile picture routes (PLAN P14-23): the avatars plugin serves the person's own, the bots plugin a bot's.

export const PersonIdParams = z.object({ personId: z.uuid() });

/** Choose a built-in picture. It replaces an uploaded photo. */
export const SetMyAvatarRequest = z.strictObject({ preset: PersonAvatarPresetId });
export type SetMyAvatarRequest = z.infer<typeof SetMyAvatarRequest>;
export const setMyAvatarRoute = { method: 'PUT', path: '/api/me/avatar' } as const;

/**
 * Upload a photo, already shrunk by the browser. `data` is the image as base64 text; the server checks the first bytes (PNG, JPEG or WebP, never SVG),
 * the size and the pixel size. It replaces a chosen built-in picture.
 */
export const UploadMyPhotoRequest = z.strictObject({
  contentType: AvatarPhotoType,
  data: z.string().min(16).max(Math.ceil((AVATAR_PHOTO_MAX_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'The photo must be base64 text'),
});
export type UploadMyPhotoRequest = z.infer<typeof UploadMyPhotoRequest>;
export const uploadMyPhotoRoute = { method: 'PUT', path: '/api/me/avatar/photo' } as const;

/** Remove the picture: the initials are drawn again. */
export const removeMyAvatarRoute = { method: 'DELETE', path: '/api/me/avatar' } as const;

export const MyAvatarResponse = z.object({ avatar: Avatar.nullable() });
export type MyAvatarResponse = z.infer<typeof MyAvatarResponse>;

/** The bytes of a person's uploaded photo (the picture URL carries `?v=` so a new photo has a new address). Any member who can see the person may load it. */
export const personAvatarRoute = { method: 'GET', path: '/api/people/:personId/avatar' } as const;

/** A lead of the bot's team or a workspace admin chooses a bot's picture (`null` clears it). Bots have no photo upload. */
export const SetBotAvatarRequest = z.strictObject({ preset: BotAvatarPresetId.nullable() });
export type SetBotAvatarRequest = z.infer<typeof SetBotAvatarRequest>;
export const SetBotAvatarResponse = z.object({ avatar: Avatar.nullable() });
export type SetBotAvatarResponse = z.infer<typeof SetBotAvatarResponse>;
export const setBotAvatarRoute = { method: 'PUT', path: '/api/teams/:slug/bots/:botSlug/avatar' } as const;
