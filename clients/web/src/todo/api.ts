import { GetThreadTodoResponse, getThreadTodoRoute } from '@manythreads/shared';
import { call } from '../api/client';

/** The to-do list a bot keeps for a thread (PLAN P25-10): `todo` is null when the thread has none, or the person cannot read it. */
export const fetchThreadTodo = (rootId: string) => call(getThreadTodoRoute, { response: GetThreadTodoResponse }, undefined, { rootId });
