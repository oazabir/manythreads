import { z } from 'zod';
import { parseMarkup } from '../../markup/parse.ts';
import { ChannelId } from '../../ids.ts';

// `@here` and `@channel` (PLAN P14-02, plugin `channels`; docs/plugins/channels.md). `@channel` tells everybody who can read the channel; `@here` tells those
// of them who are online right now. Because one word reaches many people, a message that uses either one in a room of more than
// `BROADCAST_CONFIRM_ABOVE` other readers is sent only after the writer confirmed it: the composer asks, then sends `confirmBroadcast: true`, and the
// server refuses (409 `broadcast_needs_confirmation`, nothing written) a message that names the word without it.

/** A room with more than this many readers besides the writer needs the confirmation. */
export const BROADCAST_CONFIRM_ABOVE = 20;

/** One message tells at most this many people with these words (the same cut a role group has); a bigger room is told its first 500 by person id. */
export const BROADCAST_MAX_REACH = 500;

export const BROADCAST_WORDS = ['channel', 'here'] as const;
export type BroadcastWord = (typeof BROADCAST_WORDS)[number];

/** Which of the two words a message body uses as a mention (code spans, code blocks, links and e-mail addresses are not mentions), `channel` first. */
export function broadcastWordsIn(body: string): BroadcastWord[] {
  const used = new Set(parseMarkup(body).mentions.map((m) => m.handle.toLowerCase()));
  return BROADCAST_WORDS.filter((w) => used.has(w));
}

/** The plain sentence the confirmation and the refusal share. */
export function broadcastSentence(words: readonly BroadcastWord[], people: number): string {
  const what = words.length === 2 ? '@channel and @here' : `@${words[0] ?? 'channel'}`;
  if (people > BROADCAST_MAX_REACH) return `${what} will notify up to ${BROADCAST_MAX_REACH} of the ${people} people who can read this.`;
  return `${what} will notify ${people} ${people === 1 ? 'person' : 'people'}.`;
}

/** How many people each word would notify here, for the caller (the writer is never counted). Both are 0 for a guest, whose `@here` and `@channel` are plain text. */
export const BroadcastReach = z.object({
  channel: z.number().int().nonnegative(),
  here: z.number().int().nonnegative(),
  confirmAbove: z.number().int().positive(),
});
export type BroadcastReach = z.infer<typeof BroadcastReach>;
export const BroadcastReachPathParams = z.object({ channelId: ChannelId });
export const broadcastReachRoute = { method: 'GET', path: '/api/channels/:channelId/broadcast-reach' } as const;
