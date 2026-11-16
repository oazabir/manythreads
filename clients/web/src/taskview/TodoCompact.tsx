import { useState, type ReactNode } from 'react';
import type { ThreadTodo, TodoItem } from '@manythreads/shared';
import { CaretIcon, CheckIcon, ItemBlockedIcon, ItemWaitingIcon } from '../shell/icons';
import { currentItem, progressText, STATUS_WORD, todoProgress, todoTitle } from '../channels/todo-card/words';

/** How many open items the compact card lists; the rest fold into "and N more". */
export const COMPACT_ITEMS = 4;

function Mark({ status }: { status: TodoItem['status'] }) {
  return (
    <span className="tdMark" data-status={status} aria-hidden="true">
      {status === 'done' ? <CheckIcon size={12} /> : status === 'working' ? <span className="tdPulse" /> : status === 'blocked' ? <ItemBlockedIcon size={14} /> : <ItemWaitingIcon size={14} />}
    </span>
  );
}

/**
 * The bot's list for the request, compact, under the root in the channel (P29): title and "2 of 4", the bar, and the open items (the one being worked on first). A finished list
 * says "4 of 4 done" on one line. The full list stays in the thread. No live region here: the channel has one.
 */
export function TodoCompact({ todo, trailing = null }: { todo: ThreadTodo; /** A small button at the end of the header row of a finished list ("Hide"). */ trailing?: ReactNode }) {
  const p = todoProgress(todo.items);
  const [all, setAll] = useState(false);
  const open = todo.items.filter((i) => i.status !== 'done');
  const cur = currentItem(todo.items);
  const ordered = cur === null ? open : [cur, ...open.filter((i) => i.id !== cur.id)];
  const shown = all ? ordered : ordered.slice(0, COMPACT_ITEMS);
  const hidden = ordered.length - shown.length;
  return (
    <section className="tvCard tvTodo" data-testid="tv-todo" data-all-done={p.allDone ? 'true' : 'false'} aria-label={todoTitle(todo)}>
      <header className="tvHead">
        <b className="tvTitle" dir="auto">{todoTitle(todo)}</b>
        <span className="tvCount" data-testid="tv-todo-count">{p.allDone ? `${p.done} of ${p.total} done` : progressText(p)}</span>
        {p.allDone ? trailing : null}
      </header>
      <div className="tdBar" role="img" aria-label={`${p.done} of ${p.total} done`}>
        <span style={{ width: `${p.total === 0 ? 0 : Math.round((p.done / p.total) * 100)}%` }} />
      </div>
      {p.allDone ? null : (
        <ul className="tvItems" data-testid="tv-todo-items">
          {shown.map((i) => (
            <li key={i.id} className="tvItem" data-status={i.status}>
              <Mark status={i.status} />
              <span className="tvText" dir="auto">{i.text}</span>
              <span className="sr-only"> ({STATUS_WORD[i.status]})</span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 || (all && ordered.length > COMPACT_ITEMS) ? (
        <button type="button" className="tvMore" aria-expanded={all} onClick={() => setAll((v) => !v)} data-testid="tv-todo-more">
          <span>{all ? 'Show fewer' : `and ${hidden} more`}</span>
          <span className="rcChev" aria-hidden="true"><CaretIcon open={all} /></span>
        </button>
      ) : null}
      {p.done > 0 && !p.allDone ? <p className="tvDone">{p.done} done</p> : null}
    </section>
  );
}
