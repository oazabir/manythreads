import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ChannelId, MessageId, PersonId } from '../ids.ts';

// Phase 3 read state (PLAN.md A.3 `read_state`, kernel migration 0013). One row per person per channel or thread.

/** What can be read: a channel, or a thread (identified by its root message). Matches the SQL CHECK exactly. */
export const ReadTargetType = z.enum(['channel', 'thread']);
export type ReadTargetType = z.infer<typeof ReadTargetType>;

/** A channel id or a thread id (the root message id), depending on `targetType`. */
export const ReadTarget = z.object({ targetType: ReadTargetType, targetId: z.uuid() });
export type ReadTarget = z.infer<typeof ReadTarget>;

/** Unread state of one person for one target. `lastReadId` is a message id (uuid v7: ids sort by time) or null before the first read. */
export const ReadState = z.object({
  personId: PersonId,
  targetType: ReadTargetType,
  targetId: z.uuid(),
  lastReadId: MessageId.nullable(),
  unreadCount: z.number().int().nonnegative(),
  followed: z.boolean(),
  updatedAt: IsoDateTime,
});
export type ReadState = z.infer<typeof ReadState>;

/** A person's state for one target without the row bookkeeping: what the API and the services return (zeros when nothing was ever received). */
export const ReadStateEntry = ReadState.pick({ targetType: true, targetId: true, lastReadId: true, unreadCount: true, followed: true });
export type ReadStateEntry = z.infer<typeof ReadStateEntry>;

/** What the badges need: unread per channel (only channels with unread) and one total for all followed threads. */
export const UnreadSummary = z.object({
  channels: z.array(z.object({ channelId: ChannelId, unreadCount: z.number().int().positive() })),
  threads: z.object({
    /** Threads with at least one unread message. */
    threadCount: z.number().int().nonnegative(),
    /** Unread messages summed over those threads. */
    unreadCount: z.number().int().nonnegative(),
  }),
  /** Channel and thread unread messages together. */
  total: z.number().int().nonnegative(),
});
export type UnreadSummary = z.infer<typeof UnreadSummary>;
