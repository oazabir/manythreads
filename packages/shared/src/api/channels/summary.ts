import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId, MessageId } from '../../ids.ts';

/*
 * Summarise a channel or a thread (P18-05, docs/plans/catch-me-up.md): Brain reads only the messages the asker may read (the route reads them in the asker's own
 * transaction) and writes a short summary that only the asker sees. Nothing is posted or stored. "What did I miss" is the range `new`: everything after the
 * position the screen opened with, or the stored read position. "Since I was away" is the range `away`: everything since the person's last out-of-office period
 * began (switched on), while they are away or for two weeks after they came back, and at most 30 days back (`recentAway`).
 */

export const SummaryRange = z.enum(['new', 'day', 'week', 'all', 'away']);
export type SummaryRange = z.infer<typeof SummaryRange>;

/**
 * The ranges a channel offers (`all` is a thread's only; `away` only to a person who is or was just out of office) and a thread offers (a whole thread, or since the
 * last read: a thread is short enough that "since I was away" adds nothing).
 */
export const CHANNEL_SUMMARY_RANGES = ['new', 'day', 'week', 'away'] as const satisfies readonly SummaryRange[];
export const THREAD_SUMMARY_RANGES = ['all', 'new'] as const satisfies readonly SummaryRange[];

/** How much one summary reads: the newest messages win, the rest are counted and said. */
export const SUMMARY_LIMITS = {
  /** Messages given to the model at most. */
  maxMessages: 400,
  /** One message is cut to this many characters. */
  maxMessageChars: 800,
  /** All messages together. */
  maxTotalChars: 60_000,
  /** Older messages left out are counted up to this. */
  countCap: 5_000,
  /** The longest summary kept (a model that runs on is cut). */
  maxBodyChars: 8_000,
} as const;

export const SummaryParams = z.object({ channelId: ChannelId });
export type SummaryParams = z.infer<typeof SummaryParams>;

export const SummariseRequest = z.strictObject({
  /** A thread's root: summarise that thread. Null: the channel, its top-level messages and replies. */
  threadRootId: MessageId.nullable(),
  range: SummaryRange,
  /** Range `new` only: the last message the person had read when the screen opened (null: nothing had been read there). Absent: the stored read position. */
  afterMessageId: MessageId.nullable().optional(),
});
export type SummariseRequest = z.infer<typeof SummariseRequest>;

/** A number the summary cites, and the message it stands for. */
export const SummarySource = z.object({
  n: z.number().int().positive(),
  messageId: MessageId,
  threadRootId: MessageId.nullable(),
});
export type SummarySource = z.infer<typeof SummarySource>;

export const SummariseResponse = z.discriminatedUnion('state', [
  /** Nothing in the range. */
  z.object({ state: z.literal('empty'), range: SummaryRange, messageCount: z.literal(0) }),
  z.object({
    state: z.literal('ready'),
    range: SummaryRange,
    /** Markdown with `[n]` markers; `sources` says which message each is. */
    body: z.string().min(1).max(SUMMARY_LIMITS.maxBodyChars),
    sources: z.array(SummarySource).max(SUMMARY_LIMITS.maxMessages),
    /** Messages in the range (up to the count cap). */
    messageCount: z.number().int().nonnegative(),
    /** Of those, the ones the model read. */
    readCount: z.number().int().nonnegative(),
    /** Older messages in the range that were left out (the place was too long). */
    leftOut: z.number().int().nonnegative(),
    /** The oldest and newest message read. */
    from: IsoDateTime,
    to: IsoDateTime,
    /** Who wrote it: Brain's name in this workspace. */
    botName: z.string(),
  }),
]);
export type SummariseResponse = z.infer<typeof SummariseResponse>;

export const summariseRoute = { method: 'POST', path: '/api/channels/:channelId/summary' } as const;
