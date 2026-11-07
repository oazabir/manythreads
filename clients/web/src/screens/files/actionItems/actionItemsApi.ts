import {
  ChangeActionItemRequest,
  ChangeActionItemResponse,
  ListActionItemsResponse,
  changeActionItemRoute,
  listActionItemsRoute,
  type ActionItemView,
  type TaskId,
} from '@manythreads/shared';
import { call } from '../../../api/client';
import { createTask } from '../../boards/api';

/*
 * The calls behind a person's own action items (`/api/me/action-items`, P20-12): one file in their Personal space, `Action items/action-items.md`. Every change
 * names the revision the list was read at; a save made since then is refused (409) and the screen reloads instead of overwriting it.
 */

export const fetchActionItems = () => call(listActionItemsRoute, { response: ListActionItemsResponse });

export const changeActionItem = (revision: string | null, change: ChangeActionItemRequest['change']) =>
  call(changeActionItemRoute, { request: ChangeActionItemRequest, response: ChangeActionItemResponse }, ChangeActionItemRequest.parse({ revision, change }));

/**
 * "Add to board": the card is made by the signed-in person through the tasks API, then the list is told which card it became. If the second call fails the
 * card exists: the caller says so instead of making another.
 */
export async function addItemToBoard(slug: string, revision: string | null, item: Pick<ActionItemView, 'id' | 'what' | 'owner' | 'due' | 'source'>): Promise<{ taskId: TaskId; recorded: boolean; list?: ListActionItemsResponse; problem?: string }> {
  const lines = [item.source ? `From: ${item.source}` : null, item.owner ? `Owner: ${item.owner}` : null, item.due ? `Due: ${item.due}` : null].filter((l): l is string => l !== null);
  const { task } = await createTask(slug, { title: item.what.slice(0, 200), description: lines.join('\n'), kind: 'other', priority: 'normal', branch: 'main' });
  try {
    const answer = await changeActionItem(revision, { op: 'card', id: item.id, taskId: task.id });
    return { taskId: task.id, recorded: true, list: answer.list };
  } catch (e) {
    return { taskId: task.id, recorded: false, problem: e instanceof Error ? e.message : 'The card was made, but the list could not note it.' };
  }
}
