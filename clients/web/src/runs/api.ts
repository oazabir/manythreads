import {
  ListThreadRunsResponse,
  RunActivityResponse,
  RunStopResponse,
  ThreadUnwatchResponse,
  ThreadWatchResponse,
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
/** "I have this thread open": held 60 seconds, so it is renewed every 30. */
export const watchThread = (rootId: string) => call(watchThreadRoute, { response: ThreadWatchResponse }, undefined, { rootId });
/** The thread panel closed. */
export const unwatchThread = (rootId: string) => call(unwatchThreadRoute, { response: ThreadUnwatchResponse }, undefined, { rootId });
/** Stop the run: the asker, the person who started the thread, a lead of the team, an admin. */
export const stopThreadRun = (runId: string) => call(stopRunRoute, { response: RunStopResponse }, undefined, { runId });
