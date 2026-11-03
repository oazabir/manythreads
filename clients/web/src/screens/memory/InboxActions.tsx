import { useState } from 'react';
import { Link } from 'react-router';
import type { InboxAction } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { addActionToBoard, fetchInboxActions } from './inboxApi';
import { actionWhen, message } from './inboxWords';

type Props = { slug: string; itemId: string };

/**
 * The action items a filed drop became (PLAN P8-20): one line each, with an "Add to board" the person clicks. The click makes the card as the signed-in person
 * through the tasks API, using the body the server prepared, and then tells the inbox which action it was so every viewer sees it as added. It is never a bot's act.
 */
export function InboxActions({ slug, itemId }: Props) {
  const q = useQuery(`inbox-actions:${slug}:${itemId}`, () => fetchInboxActions(slug, itemId));
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Actions added during this visit, until the server's list is read again (a card made but not noted shows as added too). */
  const [added, setAdded] = useState<Record<string, InboxAction>>({});

  if (q.status !== 'ok' || q.data.actions.length === 0) return null;
  const keyOf = (a: Pick<InboxAction, 'conceptPath' | 'index'>): string => `${a.conceptPath}#${String(a.index)}`;

  const add = async (action: InboxAction): Promise<void> => {
    const key = keyOf(action);
    setBusy(key);
    setErrors((e) => ({ ...e, [key]: '' }));
    try {
      const result = await addActionToBoard(slug, itemId, action);
      setAdded((a) => ({ ...a, [key]: result.action }));
      if (!result.recorded) setErrors((e) => ({ ...e, [key]: 'The card was made, but the inbox could not note it. Do not add it again.' }));
      else q.reload();
    } catch (e) {
      setErrors((x) => ({ ...x, [key]: message(e, 'The card could not be made.') }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mi-actions-list" data-testid="inbox-actions">
      <span className="mi-became-head">Action items</span>
      <ul className="mi-links">
        {q.data.actions.map((server) => {
          const action = added[keyOf(server)] ?? server;
          const key = keyOf(action);
          const when = actionWhen(action);
          const onBoard = action.taskId !== null;
          return (
            <li key={key} className={`mi-action ${onBoard ? 'added' : ''}`} data-testid="inbox-action" data-added={onBoard}>
              <span className="mi-action-text">
                <span className={action.done ? 'mi-action-done' : ''}>{action.what}</span>
                {when ? <span className="faint"> — {when}</span> : null}
              </span>
              {onBoard ? (
                <span className="mi-action-added" data-testid="inbox-action-added">
                  <span aria-hidden="true">✓</span> Added to the board · <Link to={`/t/${slug}/boards`}>Open the board</Link>
                </span>
              ) : action.done ? (
                <span className="faint">Already done</span>
              ) : (
                <button
                  type="button"
                  className="btn s"
                  disabled={busy !== null || !q.data.canAdd}
                  title={q.data.canAdd ? undefined : 'You cannot add cards to this team’s board.'}
                  onClick={() => void add(action)}
                  aria-label={`Add to board: ${action.what}`}
                  data-testid="inbox-action-add"
                >
                  {busy === key ? 'Adding…' : 'Add to board'}
                </button>
              )}
              {errors[key] ? <span className="mi-error" role="alert" data-testid="inbox-action-error">{errors[key]}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
