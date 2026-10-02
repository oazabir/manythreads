import { z } from 'zod';
import { ChannelKind } from '../../entities/channel.ts';
import { Page } from '../../common/page.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, ChannelId, MessageId, TeamId } from '../../ids.ts';
import { ChannelMessage } from '../channels/common.ts';
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

export const ListThreadsQuery = z.object({
  tab: ThreadsTab.default('followed'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListThreadsQuery = z.infer<typeof ListThreadsQuery>;

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
  /** The newest live reply, as the row shows it ("Tester: 213 passing ..."); null when none is left to show. */
  lastReply: z.object({ authorName: z.string(), preview: z.string().max(160) }).nullable(),
});
export type ThreadInboxItem = z.infer<typeof ThreadInboxItem>;
export const ListThreadsResponse = Page(ThreadInboxItem);
export type ListThreadsResponse = z.infer<typeof ListThreadsResponse>;
export const listThreadsRoute = { method: 'GET', path: '/api/teams/:slug/threads' } as const;
export const ListThreadsParams = z.object({ slug: TeamSlug });
