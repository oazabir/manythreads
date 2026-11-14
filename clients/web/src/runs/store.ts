import { fetchActiveRuns, fetchRunActivity, fetchThreadRuns, stopThreadRun, unwatchThread, watchThread } from './api';
import { ThreadRunsStore } from './threadRuns';

/** The tab's one store of thread runs, wired to the server. The realtime hook attaches the socket to it (realtime/index.ts). */
export const threadRunsStore = new ThreadRunsStore({
  listRuns: fetchThreadRuns,
  activeRuns: fetchActiveRuns,
  activity: fetchRunActivity,
  watch: watchThread,
  unwatch: unwatchThread,
  stop: stopThreadRun,
});
