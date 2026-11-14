import {
  ActiveChannelRunsResponse,
  ListThreadRunsResponse,
  RunActivityResponse,
  RunStopResponse,
  ThreadUnwatchResponse,
  ThreadWatchResponse,
  activeChannelRunsRoute,
  listThreadRunsRoute,
  runActivityRoute,
  stopRunRoute,
  unwatchThreadRoute,
  watchThreadRoute,
} from '@manythreads/shared';
import { call } from '../api/client';

// The calls of a run in a thread (PLAN P25-06 to P25-08): its card's head, its steps, the lease of an open thread, and Stop.

/** The runs of a thread, oldest first. */
export const fetchThreadRuns = (rootId: string) => call(listThreadRunsRoute, { response: ListThreadRunsResponse }, undefined, { rootId });
/** The head of a run, its plan and the lines after `after` (-1 for all). */
export const fetchRunActivity = (runId: string, after: number) => call(runActivityRoute, { response: RunActivityResponse }, { after }, { runId });
/** "This panel has this thread open": held 60 seconds, so it is renewed every 20. The lease id is the tab's own. */
export const watchThread = (rootId: string, leaseId: string) => call(watchThreadRoute, { response: ThreadWatchResponse }, undefined, { rootId, leaseId });
/** The thread panel closed (only this tab's lease ends). */
export const unwatchThread = (rootId: string, leaseId: string) => call(unwatchThreadRoute, { response: ThreadUnwatchResponse }, undefined, { rootId, leaseId });
/** The runs going in the threads of a channel (for the "working" chips of a page that was just opened). */
export const fetchActiveRuns = (channelId: string) => call(activeChannelRunsRoute, { response: ActiveChannelRunsResponse }, undefined, { channelId });
/** Stop the run: the asker, the person who started the thread, a lead of the team, an admin. */
export const stopThreadRun = (runId: string) => call(stopRunRoute, { response: RunStopResponse }, undefined, { runId });
