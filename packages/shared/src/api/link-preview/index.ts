import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId, MessageId } from '../../ids.ts';

// Link previews (PLAN P14-08, docs/plugins/link-preview.md): for a link in a posted message the server reads the page's title, description and
// picture and shows them as a card under the message. The browser never contacts the linked site: the picture is served by this server.

/** A message gets a card for at most this many of its links (the first ones, in the order written). */
export const LINK_PREVIEW_MAX_PER_MESSAGE = 5;
/** The most messages one batch read names. */
export const LINK_PREVIEW_MAX_BATCH = 100;
export const LINK_PREVIEW_TITLE_MAX = 200;
export const LINK_PREVIEW_DESCRIPTION_MAX = 400;
export const LINK_PREVIEW_SITE_MAX = 100;
/** The most hosts the allow list and the deny list hold, each. */
export const LINK_PREVIEW_LIST_MAX = 200;

/**
 * One card under a message. `url` is the link as written, without a user name, password or `#fragment`. `hasImage` says a picture is kept: fetch it
 * from `linkPreviewImagePath(id)`, never from the linked site (the third-party address of the picture is not sent to anyone).
 */
export const LinkPreview = z.object({
  id: z.uuid(),
  channelId: ChannelId,
  messageId: MessageId,
  url: z.string().min(1).max(2000),
  /** The site the link goes to, as the card names it. */
  host: z.string().min(1).max(253),
  title: z.string().max(LINK_PREVIEW_TITLE_MAX).nullable(),
  description: z.string().max(LINK_PREVIEW_DESCRIPTION_MAX).nullable(),
  siteName: z.string().max(LINK_PREVIEW_SITE_MAX).nullable(),
  hasImage: z.boolean(),
  /** The caller wrote the message, manages its channel or is a workspace admin, so the caller may remove this card. */
  canRemove: z.boolean(),
  createdAt: IsoDateTime,
});
export type LinkPreview = z.infer<typeof LinkPreview>;

export const LinkPreviewChannelPathParams = z.object({ channelId: ChannelId });
export const LinkPreviewMessagePathParams = z.object({ channelId: ChannelId, messageId: MessageId });
export const LinkPreviewItemPathParams = z.object({ channelId: ChannelId, messageId: MessageId, previewId: z.uuid() });
export const LinkPreviewImagePathParams = z.object({ previewId: z.uuid() });

/**
 * Which messages of a channel to read the cards of: ids joined by commas. The comma list is turned into an array before the check, and an array passes
 * unchanged, so parsing the already-parsed value (the server parses a query once, a handler may parse it again) gives the same answer.
 */
export const ListLinkPreviewsQuery = z.object({
  messageIds: z.preprocess(
    (value) =>
      typeof value === 'string' && value.length <= LINK_PREVIEW_MAX_BATCH * 37
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '')
        : value,
    z.array(MessageId).min(1).max(LINK_PREVIEW_MAX_BATCH),
  ),
});
export type ListLinkPreviewsQuery = { messageIds: string };

/**
 * `items` are the cards. `pending` names the asked messages that are new and have a link a card may still be made for in a moment (the row keeps room
 * for it). `enabled` is false when this server or this workspace does not read links at all: the client keeps no room and stops asking for a while.
 */
export const ListLinkPreviewsResponse = z.object({ items: z.array(LinkPreview), pending: z.array(MessageId), enabled: z.boolean() });
export type ListLinkPreviewsResponse = z.infer<typeof ListLinkPreviewsResponse>;
export const listLinkPreviewsRoute = { method: 'GET', path: '/api/channels/:channelId/link-previews' } as const satisfies ApiRoute;
export const listMessageLinkPreviewsRoute = { method: 'GET', path: '/api/channels/:channelId/messages/:messageId/link-previews' } as const satisfies ApiRoute;

/** The author of a message, a manager of its channel or a workspace admin takes a card off the message; it is not made again for that link, also after an edit. */
export const RemoveLinkPreviewResponse = z.object({ removed: z.boolean() });
export type RemoveLinkPreviewResponse = z.infer<typeof RemoveLinkPreviewResponse>;
export const removeLinkPreviewRoute = { method: 'DELETE', path: '/api/channels/:channelId/messages/:messageId/link-previews/:previewId' } as const satisfies ApiRoute;

export const linkPreviewImageRoute = { method: 'GET', path: '/api/link-previews/:previewId/image' } as const satisfies ApiRoute;
export const linkPreviewImagePath = (previewId: string): string => `/api/link-previews/${encodeURIComponent(previewId)}/image`;

/** The pictures the proxy serves; anything else (an SVG, an HTML page that calls itself an image) is never stored or sent. */
export const LINK_PREVIEW_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const;
export const LinkPreviewImageType = z.enum(LINK_PREVIEW_IMAGE_TYPES);
export type LinkPreviewImageType = z.infer<typeof LinkPreviewImageType>;

/**
 * The workspace's rules for which sites get a card (Settings > Workspace > Data protection). `allow` is empty for "any public site"; with entries
 * only those hosts (and their subdomains) are read. `deny` always wins. Hosts are written like `example.com`, without a scheme or a path.
 */
export const LinkPreviewSettings = z.object({
  enabled: z.boolean(),
  allow: z.array(z.string().min(1).max(253)).max(LINK_PREVIEW_LIST_MAX),
  deny: z.array(z.string().min(1).max(253)).max(LINK_PREVIEW_LIST_MAX),
  updatedAt: IsoDateTime.nullable(),
});
export type LinkPreviewSettings = z.infer<typeof LinkPreviewSettings>;

export const SetLinkPreviewSettingsRequest = z.strictObject({
  enabled: z.boolean(),
  allow: z.array(z.string().trim().min(1).max(300)).max(LINK_PREVIEW_LIST_MAX),
  deny: z.array(z.string().trim().min(1).max(300)).max(LINK_PREVIEW_LIST_MAX),
});
export type SetLinkPreviewSettingsRequest = z.infer<typeof SetLinkPreviewSettingsRequest>;
export const getLinkPreviewSettingsRoute = { method: 'GET', path: '/api/admin/link-previews' } as const satisfies ApiRoute;
export const setLinkPreviewSettingsRoute = { method: 'PUT', path: '/api/admin/link-previews' } as const satisfies ApiRoute;

/** The live push that says a message gained or lost a card: the client reads the cards of that message again. */
export const WS_LINK_PREVIEW_CHANGED = 'link-preview.changed';
export const LinkPreviewChangedPush = z.object({ channelId: ChannelId, messageId: MessageId });
export type LinkPreviewChangedPush = z.infer<typeof LinkPreviewChangedPush>;
