import { fetchThreadTodo } from './api';
import { ThreadTodoStore } from './threadTodo';

/** The tab's one store of thread to-do lists, wired to the server. The realtime hook attaches the socket to it (realtime/index.ts). */
export const threadTodoStore = new ThreadTodoStore({ read: fetchThreadTodo });
