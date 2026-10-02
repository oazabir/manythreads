import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ThreadInboxItem } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchThreadInbox } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { ThreadBody } from '../channels/ThreadPanel';
import { ago } from '../channels/format';
import { useUnread } from '../channels/hooks';
import { channelStore, threadKey } from '../channels/store';
import { useShell } from '../shell/context';
import { useNarrow } from '../shell/useNarrow';
import { BackIcon } from '../shell/icons';

type Tab = 'followed' | 'unread' | 'mine';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'followed', label: 'Followed' },
  { id: 'unread', label: 'Unread' },
  { id: 'mine', label: 'Mine' },
];
const EMPTY: Record<Tab, { title: string; body: string }> = {
  followed: { title: 'No threads yet', body: 'Threads you follow or start show up here.' },
  unread: { title: 'You are all caught up', body: 'Replies you have not read show up here.' },
  mine: { title: 'No threads of yours yet', body: 'Threads you start show up here.' },
};

const tabOf = (raw: string | null): Tab => (raw === 'unread' || raw === 'mine' ? raw : 'followed');

/** Whether the focus is somewhere the letter keys mean typing. */
const typingIn = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** The Threads inbox (SPEC 6.1): Followed · Unread · Mine on the left, the selected thread on the right. j and k move, e marks it read. */
export function ThreadsInbox() {
  const { team } = useShell();
  const slug = team?.slug ?? '';
  const [params, setParams] = useSearchParams();
  const narrow = useNarrow();
  const tab = tabOf(params.get('tab'));
  const selected = params.get('thread');
  const { threadsUnread } = useUnread();
  const q = useQuery(`inbox:${slug}:${tab}:${threadsUnread}`, () => fetchThreadInbox(slug, tab));
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo<ThreadInboxItem[]>(() => (q.status === 'ok' ? q.data.items.filter((i) => !(tab === 'unread' && done.has(i.rootMessageId))) : []), [q, tab, done]);
  const absent = q.status === 'error' && isApiError(q.error) && q.error.status === 404;

  const open = useCallback(
    (rootId: string | null, replace = false): void => {
      const next = new URLSearchParams(params);
      if (rootId) next.set('thread', rootId);
      else next.delete('thread');
      setParams(next, { replace });
    },
    [params, setParams],
  );
  const setTab = (t: Tab): void => {
    const next = new URLSearchParams(params);
    if (t === 'followed') next.delete('tab');
    else next.set('tab', t);
    next.delete('thread');
    setParams(next);
  };

  // On a wide screen the first thread is open, as in the prototype.
  useEffect(() => {
    if (!narrow && !selected && items[0]) open(items[0].rootMessageId, true);
  }, [narrow, selected, items, open]);

  const markDone = useCallback(
    (rootId: string): void => {
      const tl = channelStore.get(threadKey(rootId));
      const upTo = tl.items.at(-1)?.id ?? rootId;
      void channelStore.markRead('thread', rootId, upTo);
      setDone((s) => new Set(s).add(rootId));
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
      const i = items.findIndex((x) => x.rootMessageId === selected);
      if (e.key === 'j' || e.key === 'k') {
        const next = items[e.key === 'j' ? Math.min(items.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)];
        if (next) {
          e.preventDefault();
          open(next.rootMessageId, true);
          listRef.current?.querySelector<HTMLElement>(`[data-root-id="${next.rootMessageId}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'e' && selected) {
        e.preventDefault();
        markDone(selected);
        const after = items[i + 1] ?? items[i - 1];
        if (tab === 'unread' && after) open(after.rootMessageId, true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, selected, open, markDone, tab]);

  const showMain = !narrow || selected !== null;
  const showList = !narrow || selected === null;
  return (
    <div className={`inbox ${narrow ? 'narrow' : ''}`} data-testid="threads-inbox">
      {showList ? (
        <div className="inl">
          <div className="inh">
            <div className="tabs2" role="tablist" aria-label="Threads">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                  {t.label}
                  {t.id === 'unread' && threadsUnread > 0 ? <span data-vt-mask>{` · ${threadsUnread}`}</span> : null}
                </button>
              ))}
            </div>
          </div>
          {q.status === 'loading' ? (
            <p className="loading" aria-busy="true">Loading…</p>
          ) : absent || (q.status === 'ok' && items.length === 0) ? (
            <div className="inl-empty" data-testid="threads-empty">
              <p className="view-empty-title">{EMPTY[tab].title}</p>
              <p className="view-empty-body">{EMPTY[tab].body}</p>
            </div>
          ) : q.status === 'error' ? (
            <div className="inl-empty" role="alert">
              <p className="view-empty-title">Could not load threads.</p>
              <button type="button" className="btn s" onClick={q.reload}>Try again</button>
            </div>
          ) : (
            <ul className="inlist" ref={listRef} role="listbox" aria-label={`${TABS.find((t) => t.id === tab)?.label ?? ''} threads`}>
              {items.map((it) => {
                const unread = it.unreadCount > 0;
                const on = it.rootMessageId === selected;
                return (
                  <li key={it.rootMessageId} role="option" aria-selected={on} data-root-id={it.rootMessageId} data-testid="thread-row">
                    <button type="button" className={`trow ${unread ? 'unread' : ''} ${on ? 'on' : ''}`} onClick={() => open(it.rootMessageId)}>
                      <span className="trow-main">
                        <span className="ch">{it.channel.kind === 'dm' ? 'Direct message' : `# ${it.channel.name.replace(/^#/, '')}`}</span>
                        <span className="ttl">{it.title}</span>
                        <span className="last">{it.replyCount === 1 ? '1 reply' : `${it.replyCount} replies`}</span>
                      </span>
                      <span className="meta">
                        <span data-vt-mask>{ago(it.lastReplyAt)}</span>
                        {unread ? <span className="cnt" data-vt-mask>{it.unreadCount}</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
      {showMain ? (
        <div className="inr">
          {narrow ? (
            <button type="button" className="btn s back-to-list" onClick={() => open(null)}>
              <BackIcon />
              <span>Threads</span>
            </button>
          ) : null}
          {selected ? (
            <ThreadBody key={selected} rootId={selected} variant="main" />
          ) : (
            <div className="inr-empty">
              <p className="view-empty-title">Pick a thread</p>
              <p className="view-empty-body">Its messages show here. Press j and k to move, e to mark it read.</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
