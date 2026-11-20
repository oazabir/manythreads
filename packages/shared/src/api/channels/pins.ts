import { z } from 'zod';
import { ChannelId, MessageId } from '../../ids.ts';
import { ChannelMessage } from './common.ts';

/*
 * Pinned messages of a channel (PLAN P31-07). A pin keeps a message in the channel's pinned list, the way a notice is pinned to a board. Whoever can
 * read the channel sees its pins; whoever can post in it pins and unpins (the same set as the bookmarks bar). Separate from P9-09, which exports a
 * bot's screen to pages.
 */

/** The most messages one channel keeps pinned. */
export const MAX_CHANNEL_PINS = 100;

export const PinsPathParams = z.object({ channelId: ChannelId });
export type PinsPathParams = z.infer<typeof PinsPathParams>;
export const PinMessagePathParams = z.object({ channelId: ChannelId, messageId: MessageId });
export type PinMessagePathParams = z.infer<typeof PinMessagePathParams>;

/** The channel's pinned messages, the newest pin first; each is the whole message as this reader sees it, with `pinned` set. */
export const ListPinsResponse = z.object({ items: z.array(ChannelMessage) });
export type ListPinsResponse = z.infer<typeof ListPinsResponse>;
export const listPinsRoute = { method: 'GET', path: '/api/channels/:channelId/pins' } as const;

/** What pinning or unpinning answers: the state now, and whether this call changed it (pinning a pinned message changes nothing). */
export const PinMessageResponse = z.object({ pinned: z.boolean(), changed: z.boolean() });
export type PinMessageResponse = z.infer<typeof PinMessageResponse>;
export const pinMessageRoute = { method: 'PUT', path: '/api/channels/:channelId/messages/:messageId/pin' } as const;
export const unpinMessageRoute = { method: 'DELETE', path: '/api/channels/:channelId/messages/:messageId/pin' } as const;
