import {
  ActiveChannelRunsResponse,
  ChannelApprovalsResponse,
  ChannelTodosResponse,
  ThreadCountsResponse,
  ThreadsRunningResponse,
  activeThreadRunsRoute,
  listThreadBatchApprovalsRoute,
  listThreadBatchTodosRoute,
  threadCountsRoute,
  threadsRunningRoute,
} from '@manythreads/shared';
import { call } from '../api/client';

// The Threads view's batched reads (P29): what is going on in the listed threads, one read per kind for the whole page, and the two counts of the sidebar.

const roots = (list: readonly string[]) => ({ roots: list.join(',') });
export const fetchBatchRuns = (list: readonly string[]) => call(activeThreadRunsRoute, { response: ActiveChannelRunsResponse }, roots(list));
export const fetchBatchTodos = (list: readonly string[]) => call(listThreadBatchTodosRoute, { response: ChannelTodosResponse }, roots(list));
export const fetchBatchApprovals = (list: readonly string[]) => call(listThreadBatchApprovalsRoute, { response: ChannelApprovalsResponse }, roots(list));
/** The threads of the team that wait on the person because a message names them (the sidebar's mention count). */
export const fetchThreadMentions = (slug: string) => call(threadCountsRoute, { response: ThreadCountsResponse }, undefined, { slug });
/** In how many threads of the team a run is going (the sidebar's tasks-in-progress count). */
export const fetchThreadsRunning = (slug: string) => call(threadsRunningRoute, { response: ThreadsRunningResponse }, undefined, { slug });
