import { useState } from 'react';
import { Link } from 'react-router';
import type { ThreadTodo, TodoItem } from '@manythreads/shared';
import { Avatar } from '../../components/ui';
import { CaretIcon, CheckIcon, ItemBlockedIcon, ItemWaitingIcon } from '../../shell/icons';
import type { People } from '../hooks';
import { barLine, isOpen, progressText, STATUS_WORD, todoProgress, todoTitle } from './words';

/*
 * The to-do card (PLAN P25-11, docs/plans/acp.md section 5.3): the bot's list for the request, in the thread. `TodoCard` is the whole list, in place of the message that carries
 * it; `TodoPin` is one quiet line at the top of the thread panel while anything is open, which opens to the same list.
 */

function Mark({ status }: { status: TodoItem['status'] }) {
  return (
    <span className="tdMark" data-status={status} aria-hidden="true">
      {status === 'done' ? <CheckIcon size={12} /> : status === 'working' ? <span className="tdPulse" /> : status === 'blocked' ? <ItemBlockedIcon size={14} /> : <ItemWaitingIcon size={14} />}
    </span>
  );
}

function Item({ item, slug, people }: { item: TodoItem; slug: string | null; people: People }) {
  const owner = item.ownerId !== undefined ? people.byActor(item.ownerId) : undefined;
  const ownerBot = item.ownerId !== undefined && owner === undefined ? people.botAvatar(item.ownerId) : undefined;
  const link = item.taskId !== undefined && slug !== null ? `/t/${slug}/boards?card=${item.taskId}` : null;
  return (
    <li className="tdItem" data-status={item.status} data-testid="todo-item">
      <Mark status={item.status} />
      <span className="tdText">{item.text}</span>
      <span className="sr-only"> ({STATUS_WORD[item.status]})</span>
      {item.status === 'blocked' ? <span className="tdTag" data-tone="blocked">Blocked</span> : null}
      {owner !== undefined ? <Avatar name={owner.name} kind="person" avatar={owner.avatar} /> : ownerBot !== undefined ? <Avatar name="Owner" kind="agent" avatar={ownerBot} /> : null}
      {link !== null ? <Link className="tdLink" to={link} aria-label={`Open the card for: ${item.text}`}>Card</Link> : null}
    </li>
  );
}

export function TodoList({ todo, slug, people }: { todo: ThreadTodo; slug: string | null; people: People }) {
  return (
    <ul className="tdList" data-testid="todo-items">
      {todo.items.map((i) => <Item key={i.id} item={i} slug={slug} people={people} />)}
    </ul>
  );
}

/** The card: title, "3 of 5" and the items. Stands in the thread where the bot's list message was posted. */
export function TodoCard({ todo, slug, people, botName = 'Bot' }: { todo: ThreadTodo; slug: string | null; people: People; botName?: string }) {
  const p = todoProgress(todo.items);
  const bot = people.botAvatar(todo.botActorId);
  return (
    <section className="td" data-testid="todo-card" data-all-done={p.allDone ? 'true' : 'false'} aria-label={`${todoTitle(todo)}: ${progressText(p)}`}>
      <header className="tdHead">
        <Avatar name={botName} kind="agent" avatar={bot ?? null} />
        <b className="tdTitle">{todoTitle(todo)}</b>
        <span className="tdCount" data-testid="todo-progress" role="status">{progressText(p)}</span>
      </header>
      <div className="tdBar" role="img" aria-label={`${p.done} of ${p.total} done`}>
        <span style={{ width: `${p.total === 0 ? 0 : Math.round((p.done / p.total) * 100)}%` }} />
      </div>
      <TodoList todo={todo} slug={slug} people={people} />
    </section>
  );
}

/** One line at the top of the thread panel while the list has open items: what is being worked on and "3 of 5"; a button that opens the list. */
export function TodoPin({ todo, slug, people }: { todo: ThreadTodo; slug: string | null; people: People }) {
  const [open, setOpen] = useState(false);
  if (!isOpen(todo.items)) return null;
  const line = barLine(todo);
  return (
    <div className="tdPin" data-testid="todo-pin" data-tone={line.tone}>
      <button type="button" className="tdPinBtn" aria-expanded={open} aria-label={`${todoTitle(todo)}: ${line.progress}. ${line.text}`} onClick={() => setOpen((o) => !o)}>
        <span className="tdPinTitle">{todoTitle(todo)}</span>
        <span className="tdPinNow">{line.text}</span>
        <span className="tdCount">{line.progress}</span>
        <span className="rcChev" aria-hidden="true"><CaretIcon open={open} /></span>
      </button>
      {open ? <TodoList todo={todo} slug={slug} people={people} /> : null}
    </div>
  );
}
