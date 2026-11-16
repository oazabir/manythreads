import { z } from 'zod';
import { ChannelKind } from '../../entities/channel.ts';
import { Page } from '../../common/page.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, ChannelId, MessageId, TeamId } from '../../ids.ts';
import { ActorKind } from '../../entities/kernel.ts';
import { ChannelMessage, MessageAuthor } from '../channels/common.ts';
import { TeamSlug } from '../teams/common.ts';

// Threads: one thread per root message (SPEC 6.1, PLAN P3-06). A reply is posted with `postMessageRoute` (threadRootId set); these
// routes read a thread, follow it, and list the Threads inbox.

/** Where a thread lives: enough to draw `#dev` or a direct message and to link to it. */
export const ThreadChannelRef = z.object({
  id: ChannelId,
  name: z.string(),
  kind: ChannelKind,
  teamId: TeamId.nullable(),
  private: z.boolean(),
});
export type ThreadChannelRef = z.infer<typeof ThreadChannelRef>;

export const ThreadPathParams = z.object({ rootId: MessageId });
export type ThreadPathParams = z.infer<typeof ThreadPathParams>;

/** What the caller knows about the thread: follow flag and unread (from the read state; zeros before the first reply). */
export const ThreadState = z.object({
  rootMessageId: MessageId,
  channelId: ChannelId,
  title: z.string(),
  replyCount: z.number().int().nonnegative(),
  /** Time of the latest reply, or null for a message that has none yet. */
  lastReplyAt: IsoDateTime.nullable(),
  followed: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  lastReadId: MessageId.nullable(),
});
export type ThreadState = z.infer<typeof ThreadState>;

/** Replies newest first, like the channel list: `before` is the id of the oldest reply the client holds. */
export const GetThreadQuery = z.object({
  before: MessageId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type GetThreadQuery = z.infer<typeof GetThreadQuery>;

/** A thread opened in the right panel: the root message, the thread's state for the caller, the channel, and a page of replies. */
export const GetThreadResponse = z.object({
  channel: ThreadChannelRef,
  root: ChannelMessage,
  thread: ThreadState,
  replies: Page(ChannelMessage),
});
export type GetThreadResponse = z.infer<typeof GetThreadResponse>;
export const getThreadRoute = { method: 'GET', path: '/api/threads/:rootId' } as const;

/** Follow or unfollow: `changed` is false when the thread was already in that state. */
export const FollowThreadResponse = z.object({ followed: z.boolean(), changed: z.boolean() });
export type FollowThreadResponse = z.infer<typeof FollowThreadResponse>;
export const followThreadRoute = { method: 'POST', path: '/api/threads/:rootId/follow' } as const;
export const unfollowThreadRoute = { method: 'POST', path: '/api/threads/:rootId/unfollow' } as const;

/** The Threads inbox tabs: threads I follow, threads with replies I have not read, threads I started (or hold a task in, phase 6). */
export const ThreadsTab = z.enum(['followed', 'unread', 'mine']);
export type ThreadsTab = z.infer<typeof ThreadsTab>;

/** Ids separated by commas (a query string carries a list this way; the handler splits it with `idList`). */
const ID_LIST = /^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/;
/** The ids of a comma separated query value, the first `max` of them. */
export const idList = (value: string | undefined, max: number): string[] => (value ?? '').split(',').filter((x) => x.length > 0).slice(0, max);

/** The most actors one filter names with `@name` (P29: the Threads view's filter box). */
export const THREAD_FILTER_MENTIONS_MAX = 5;
/** The longest text the filter box sends. */
export const THREAD_FILTER_TEXT_MAX = 200;
/** Threads one filtered answer holds (no paging: a filter narrows the list). */
export const THREAD_FILTER_RESULTS_MAX = 100;

export const ListThreadsQuery = z.object({
  tab: ThreadsTab.default('followed'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(512).optional(),
  /**
   * The Threads view's filter (P29): words that must each appear in the channel's name or in the text of a live message of the thread. With `q` or `mentions` the answer
   * is the matching threads of the tab, channel-name matches first, at most `THREAD_FILTER_RESULTS_MAX`, and has no `nextCursor`.
   */
  q: z.string().trim().min(1).max(THREAD_FILTER_TEXT_MAX).optional(),
  /** Actor ids (comma separated) that must be mentioned in some live message of the thread: the `@name` words of the filter. */
  mentions: z
    .string()
    .max(THREAD_FILTER_MENTIONS_MAX * 37)
    .regex(ID_LIST, 'mentions: ids separated by commas')
    .optional(),
});
export type ListThreadsQuery = z.infer<typeof ListThreadsQuery>;

/** The most authors an inbox row carries (it draws a stack of their pictures). */
export const THREAD_PARTICIPANTS_SHOWN = 5;

/** How long an unanswered mention keeps a thread in "Needs you". */
export const THREAD_MENTION_DAYS = 7;
export const ThreadMention = z.object({
  messageId: MessageId,
  authorId: ActorId,
  authorName: z.string(),
  kind: ActorKind,
  at: IsoDateTime,
  /** The first words of the message, one line of plain text. */
  preview: z.string().max(240),
});
export type ThreadMention = z.infer<typeof ThreadMention>;

/** One row of the inbox. Sorted by `lastReplyAt`, newest first. */
export const ThreadInboxItem = z.object({
  rootMessageId: MessageId,
  channel: ThreadChannelRef,
  title: z.string(),
  rootAuthorId: ActorId,
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoDateTime,
  followed: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  /** The caller wrote the root message. */
  mine: z.boolean(),
  /** Who wrote the root message, named the way the channel list names an author; null when the server may not name them. */
  rootAuthor: MessageAuthor.nullable(),
  /** Up to `THREAD_PARTICIPANTS_SHOWN` people (or bots) who wrote in the thread: the root's author first, then the newest repliers. */
  participants: z.array(MessageAuthor).max(THREAD_PARTICIPANTS_SHOWN),
  /** How many distinct authors the thread has, which may be more than `participants` lists. */
  participantCount: z.number().int().nonnegative(),
  /** Unread replies that name the caller (a tag): the row shows it as a number in place of the unread dot. Never more than `unreadCount`. */
  mentionCount: z.number().int().nonnegative(),
  /**
   * The newest live reply, as the row shows it ("Tester: 213 passing ..."); null when none is left to show. `authorId`, `kind`, `at` and `messageId` (P29) give the small
   * avatar, the name's kind and the relative time of the "Latest reply" block; an older server leaves them out.
   */
  lastReply: z
    .object({
      authorName: z.string(),
      preview: z.string().max(240),
      authorId: ActorId.optional(),
      kind: ActorKind.optional(),
      at: IsoDateTime.optional(),
      messageId: MessageId.optional(),
    })
    .nullable(),
  /**
   * The newest message of the thread (the root included) that names the caller (a mention of a person or bot, a room word like @channel included, as the unread mention count does; a #channel link does not count), was written by someone else, is newer than
   * the caller's own last message in the thread and at most `THREAD_MENTION_DAYS` old: "waiting for you". Null when there is none (P29).
   */
  mention: ThreadMention.nullable().optional(),
});
export type ThreadInboxItem = z.infer<typeof ThreadInboxItem>;
export const ListThreadsResponse = Page(ThreadInboxItem);
export type ListThreadsResponse = z.infer<typeof ListThreadsResponse>;
export const listThreadsRoute = { method: 'GET', path: '/api/teams/:slug/threads' } as const;
export const ListThreadsParams = z.object({ slug: TeamSlug });

/** The most threads one batch read names: the page the Threads view has loaded (it pages by 50; a longer filtered list asks in chunks). */
export const THREAD_BATCH_MAX = 50;
/**
 * The batch reads of the Threads view (P29): what is going on in the listed threads (runs, to-do lists, pending approvals), one read per kind for the whole page. The roots are
 * comma separated; a thread the caller cannot read answers nothing (the rows' own policies decide).
 */
export const ThreadBatchQuery = z.object({
  roots: z.string().max(THREAD_BATCH_MAX * 37).regex(ID_LIST, 'roots: ids separated by commas'),
});
export type ThreadBatchQuery = z.infer<typeof ThreadBatchQuery>;

/** The sidebar's Threads entry (P29): threads that wait on the caller because a message names them and they have not answered. Same rule as `ThreadInboxItem.mention`, over every thread of the team. */
export const ThreadCountsResponse = z.object({ mentions: z.number().int().nonnegative() });
export type ThreadCountsResponse = z.infer<typeof ThreadCountsResponse>;
export const threadCountsRoute = { method: 'GET', path: '/api/teams/:slug/threads/counts' } as const;
