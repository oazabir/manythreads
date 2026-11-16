import { ChannelTasksStore } from './channelTasks';
import { fetchActiveRuns, fetchRunActivity } from '../runs/api';
import { fetchChannelApprovals, fetchChannelTodos, unwatchChannel, watchChannel } from './api';

/** The tab's one store of channel task views, wired to the server. The realtime hook attaches the socket to it (realtime/index.ts). */
export const channelTasksStore = new ChannelTasksStore({
  activeRuns: fetchActiveRuns,
  todos: fetchChannelTodos,
  approvals: fetchChannelApprovals,
  activity: fetchRunActivity,
  watch: watchChannel,
  unwatch: unwatchChannel,
});
