import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import type { ThreadTodo, TodoItem } from '@manythreads/shared';
import { Avatar } from '../../components/ui';
import { CaretIcon, CheckIcon, ItemBlockedIcon, ItemWaitingIcon, OpenCardIcon } from '../../shell/icons';
import type { People } from '../hooks';
import { barLine, foldDone, isOpen, progressText, STATUS_WORD, todoProgress, todoTitle } from './words';

/*
 * The to-do card (PLAN P25-11, docs/plans/acp.md section 5.5): the bot's list for the request, in the thread. `TodoCard` is the whole list, in place of the message that carries
 * it (the message already has the bot's picture and name, so the card has neither); `TodoPin` is one quiet line at the top of the thread panel while anything is open and
 * the card itself is out of sight, which opens to the same list.
 */

// ---- is the card on screen? (the pin shows only when it is not) -----------------------------------------------------------------

const inView = new Map<string, boolean>();
const viewListeners = new Map<string, Set<() => void>>();
function setInView(rootId: string, on: boolean): void {
  if ((inView.get(rootId) ?? false) === on) return;
  inView.set(rootId, on);
  for (const l of [...(viewListeners.get(rootId) ?? [])]) l();
}
function useCardInView(rootId: string | undefined): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (rootId === undefined) return () => undefined;
      const set = viewListeners.get(rootId) ?? new Set();
      set.add(onChange);
      viewListeners.set(rootId, set);
      return () => set.delete(onChange);
    },
    [rootId],
  );
  return useSyncExternalStore(subscribe, () => (rootId === undefined ? false : (inView.get(rootId) ?? false)), () => false);
}

// ---- an item ------------------------------------------------------------------------------------------------------------------------

function Mark({ status }: { status: TodoItem['status'] }) {
  return (
    <span className="tdMark" data-status={status} aria-hidden="true">
      {status === 'done' ? <CheckIcon size={12} /> : status === 'working' ? <span className="tdPulse" /> : status === 'blocked' ? <ItemBlockedIcon size={14} /> : <ItemWaitingIcon size={14} />}
    </span>
  );
}

/** The name of whoever holds an item's card: a person of the team, or one of its bots. */
function ownerOf(item: TodoItem, people: People): { name: string; avatar: string | null; kind: 'person' | 'agent' } | null {
  if (item.ownerId === undefined) return null;
  const person = people.byActor(item.ownerId);
  if (person !== undefined) return { name: person.name, avatar: person.avatar ?? null, kind: 'person' };
  const avatar = people.botAvatar(item.ownerId);
  const name = people.botName?.(item.ownerId);
  if (avatar === undefined && name === undefined) return null;
  return { name: name ?? 'A bot', avatar: avatar ?? null, kind: 'agent' };
}

function Item({ item, slug, people }: { item: TodoItem; slug: string | null; people: People }) {
  const owner = ownerOf(item, people);
  const link = item.taskId !== undefined && slug !== null ? `/t/${slug}/boards?card=${item.taskId}` : null;
  // the second line: who is on an item that follows a card, while it is being worked on
  const sub = item.status === 'working' && owner !== null ? `${owner.name} is on it` : item.status === 'blocked' ? 'Blocked' : null;
  return (
    <li className="tdItem" data-status={item.status} data-testid="todo-item">
      <Mark status={item.status} />
      <span className="tdBody">
        {link !== null ? (
          <Link className="tdText tdLink" to={link} dir="auto" title="Open its card">
            {item.text}
            <OpenCardIcon />
          </Link>
        ) : (
          <span className="tdText" dir="auto">{item.text}</span>
        )}
        <span className="sr-only"> ({STATUS_WORD[item.status]})</span>
        {sub !== null ? <span className="tdSub" data-tone={item.status} aria-hidden={item.status === 'blocked' ? true : undefined}>{sub}</span> : null}
      </span>
      {owner !== null ? (
        <span className="tdOwner" title={owner.name} aria-label={`Card held by ${owner.name}`} role="img">
          <Avatar name={owner.name} kind={owner.kind} avatar={owner.avatar} />
        </span>
      ) : null}
    </li>
  );
}

/** The items; on a long list the finished ones fold into one line at the top, so the open ones are what a person sees. */
export function TodoList({ todo, slug, people }: { todo: ThreadTodo; slug: string | null; people: People }) {
  const [showDone, setShowDone] = useState(false);
  const folded = foldDone(todo.items);
  const items = showDone || folded === 0 ? todo.items : todo.items.filter((i) => i.status !== 'done');
  return (
    <>
      {folded > 0 ? (
        <button type="button" className="tdDoneFold" aria-expanded={showDone} onClick={() => setShowDone((o) => !o)} data-testid="todo-done-fold">
          <span className="tdMark" data-status="done" aria-hidden="true"><CheckIcon size={12} /></span>
          <span>{folded} done</span>
          <span className="rcChev" aria-hidden="true"><CaretIcon open={showDone} /></span>
        </button>
      ) : null}
      <ul className="tdList" data-testid="todo-items">
        {items.map((i) => <Item key={i.id} item={i} slug={slug} people={people} />)}
      </ul>
    </>
  );
}

/** The card: title, "3 of 5", a bar and the items. Stands in the thread where the bot's list message was posted. */
export function TodoCard({ todo, slug, people, rootId }: { todo: ThreadTodo; slug: string | null; people: People; rootId?: string }) {
  const p = todoProgress(todo.items);
  // the pin stands in for the card's head (its title and "3 of 5") while that is scrolled out of sight
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = box.current;
    if (rootId === undefined || el === null || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setInView(rootId, entries.some((e) => e.isIntersecting)), { threshold: [0, 1] });
    io.observe(el);
    return () => {
      io.disconnect();
      setInView(rootId, false);
    };
  }, [rootId]);
  return (
    <section className="td" data-testid="todo-card" data-all-done={p.allDone ? 'true' : 'false'} aria-label={todoTitle(todo)}>
      <header className="tdHead" ref={box}>
        <b className="tdTitle" dir="auto">{todoTitle(todo)}</b>
        <span className="tdCount" data-testid="todo-progress" role="status">{progressText(p)}</span>
      </header>
      <div className="tdBar" role="img" aria-label={`${p.done} of ${p.total} done`}>
        <span style={{ width: `${p.total === 0 ? 0 : Math.round((p.done / p.total) * 100)}%` }} />
      </div>
      <TodoList todo={todo} slug={slug} people={people} />
    </section>
  );
}

/**
 * One line at the top of the thread panel while the list has open items and its card is out of sight: "To do", "3 of 5" and what is being worked on; a button that opens
 * the list (it scrolls in its own box, so a long list never covers the thread).
 */
export function TodoPin({ todo, slug, people, rootId }: { todo: ThreadTodo; slug: string | null; people: People; rootId: string }) {
  const [open, setOpen] = useState(false);
  const cardShown = useCardInView(rootId);
  if (!isOpen(todo.items) || (cardShown && !open)) return null;
  const line = barLine(todo, (id) => people.byActor(id)?.name ?? people.botName?.(id));
  return (
    <div className="tdPin" data-testid="todo-pin" data-tone={line.tone}>
      <button type="button" className="tdPinBtn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {line.tone === 'working' ? <span className="tdPulse" aria-hidden="true" /> : <span className="tdMark" data-status={line.tone} aria-hidden="true">{line.tone === 'blocked' ? <ItemBlockedIcon size={14} /> : <ItemWaitingIcon size={14} />}</span>}
        {/* "To do", not the list's title: in a panel 360 px wide a title and the item both lost their ends ("Jump to latest in t… · Engineer is working …"); the title is the tooltip */}
        <span className="tdPinTitle" title={todoTitle(todo)}>To do</span>
        <span className="tdCount">{line.progress}</span>
        <span className="tdPinNow" dir="auto">{line.text}</span>
        <span className="rcChev" aria-hidden="true"><CaretIcon open={open} /></span>
      </button>
      {open ? (
        <div className="tdPinList">
          <TodoList todo={todo} slug={slug} people={people} />
        </div>
      ) : null}
    </div>
  );
}
