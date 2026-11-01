import { z } from 'zod';
import { CUSTOM_EMOJI_MAX_BYTES, CustomEmoji, CustomEmojiName, CustomEmojiType } from '../../entities/custom-emoji.ts';
import { CustomEmojiId } from '../../ids.ts';

// Custom emoji (PLAN P14-02, plugin `channels`; docs/plugins/channels.md). Anyone in the workspace reads the list and the pictures; only a workspace
// owner or admin adds or removes one. A picture is stored in the database (at most 256 KiB), checked by its bytes, and served from this server.

export const CustomEmojiPathParams = z.object({ emojiId: CustomEmojiId });

/** Base64 of the biggest picture, with the padding. */
const MAX_BASE64 = Math.ceil(CUSTOM_EMOJI_MAX_BYTES / 3) * 4;

/** Every custom emoji of the workspace, by name. */
export const ListCustomEmojiResponse = z.object({ items: z.array(CustomEmoji) });
export type ListCustomEmojiResponse = z.infer<typeof ListCustomEmojiResponse>;
export const listCustomEmojiRoute = { method: 'GET', path: '/api/custom-emoji' } as const;

/**
 * Add one (workspace owner or admin). `contentType` is what the browser says the file is; the server checks the bytes and refuses a mismatch.
 * 409 when the name is taken or the workspace already holds 500.
 */
export const AddCustomEmojiRequest = z.strictObject({
  name: CustomEmojiName,
  contentType: CustomEmojiType,
  /** The picture, base64 encoded. */
  data: z.base64().min(16).max(MAX_BASE64),
});
export type AddCustomEmojiRequest = z.infer<typeof AddCustomEmojiRequest>;
export const AddCustomEmojiResponse = CustomEmoji;
export type AddCustomEmojiResponse = z.infer<typeof AddCustomEmojiResponse>;
export const addCustomEmojiRoute = { method: 'POST', path: '/api/custom-emoji' } as const;

/** Remove one (workspace owner or admin). Removing twice is fine: `deleted` is false the second time. Reactions that used it keep the text `:name:`. */
export const DeleteCustomEmojiResponse = z.object({ deleted: z.boolean() });
export type DeleteCustomEmojiResponse = z.infer<typeof DeleteCustomEmojiResponse>;
export const deleteCustomEmojiRoute = { method: 'DELETE', path: '/api/custom-emoji/:emojiId' } as const;

/** The picture itself (the bytes, with its own content type). Any member of the workspace. */
export const customEmojiImageRoute = { method: 'GET', path: '/api/custom-emoji/:emojiId/image' } as const;
