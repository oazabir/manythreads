import {
  ChannelApprovalsResponse,
  ChannelTodosResponse,
  ChannelUnwatchResponse,
  ChannelWatchResponse,
  listChannelApprovalsRoute,
  listChannelTodosRoute,
  unwatchChannelRoute,
  watchChannelRoute,
} from '@manythreads/shared';
import { call } from '../api/client';

// The channel's three batched reads and its one lease (P29): everything the task view under the roots needs, with no request per thread.

/** The open to-do lists of a channel's threads. */
export const fetchChannelTodos = (channelId: string) => call(listChannelTodosRoute, { response: ChannelTodosResponse }, undefined, { channelId });
/** The pending questions that came from a thread of the channel. A person who cannot read them gets none. */
export const fetchChannelApprovals = (channelId: string) => call(listChannelApprovalsRoute, { response: ChannelApprovalsResponse }, undefined, { channelId });
/** "This page has this channel open": held 60 seconds, renewed every 20. The lease id is the tab's own. */
export const watchChannel = (channelId: string, leaseId: string) => call(watchChannelRoute, { response: ChannelWatchResponse }, undefined, { channelId, leaseId });
export const unwatchChannel = (channelId: string, leaseId: string) => call(unwatchChannelRoute, { response: ChannelUnwatchResponse }, undefined, { channelId, leaseId });
