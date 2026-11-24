import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { ListSavedBookmarksResponse, SavedBookmark } from '@manythreads/shared';
import { fetchSavedBookmarks } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { BOOKMARK_TABS, EMPTY_TEXT, LIST_LABEL, canUndoRemoval, fileMetaOf, openOf, placeOf, repliesText, shortWhen, shownBookmarks, shownCount, tabFrom, type BookmarkOpen, type BookmarkTabId, type PageRemoval } from '../../bookmarks/model';
import { bookmarkErrorText, bookmarksStore, useBookmarksSupported } from '../../bookmarks/store';
import { PageHeader } from '../../components/PageHeader';
import { sayToast } from '../../kernel/toast';
import { BookmarkToggleIcon } from '../../shell/icons';
import { useOpenMessage } from '../../shell/messageLink';
import { usePanel } from '../../kernel/panel';

/*
 * Bookmarks (P36-08, docs/plans/bookmarks.md): the threads, messages and files the person keeps to find again, newest first, in three tabs with their
 * counts (`?tab=thread|message|file`). A row opens where the item lives: a thread with the thread on the right, a message scrolled to and flashed, a reply
 * with its thread on the right and the reply highlighted, a message of a chat with a bot in that chat, highlighted; a file of a team's repository in that
 * team's Files, a Personal file in Personal, an attachment in the right panel. Something the person can no longer read says "No longer available" and can
 * only be removed. j and k move between rows, Enter opens, Delete removes (with Undo for a few seconds).
 */

const UNDO_MS = 5_000;

/** What a row is called for a screen reader's Remove button. */
const nameOf = (b: SavedBookmark): string => {
  const item = b.item;
  if (!item) return '';
  return item.kind === 'thread' ? item.title || item.snippet : item.kind === 'message' ? item.snippet : item.name;
};

function Row({ b, onOpen, onRemove, onKey }: { b: SavedBookmark; onOpen: () => void; onRemove: () => void; onKey: (e: KeyboardEvent<HTMLElement>) => void }) {
  const item = b.item;
  return (
    <li className="bk-row" data-testid="bookmark-row" data-kind={b.target.kind} data-id={b.id}>
      {item ? (
        <button type="button" className="bk-open" onClick={onOpen} onKeyDown={onKey} data-testid="bookmark-open" data-missing={item.kind === 'file' && item.missing ? 'true' : undefined}>
          <span className="bk-head">
            <span className="bk-place">{placeOf(item)}</span>
            <span className="bk-when" data-vt-mask>{item.kind === 'thread' ? (item.lastReplyAt ? `Last reply ${shortWhen(item.lastReplyAt)}` : '') : item.kind === 'message' ? shortWhen(item.messageCreatedAt) : ''}</span>
          </span>
          {item.kind === 'thread' ? (
            <>
              <span className="bk-title">{item.title || item.snippet || 'Thread'}</span>
              <span className="bk-meta">{item.rootAuthorName ? `${item.rootAuthorName} · ` : ''}{repliesText(item.replyCount)}</span>
            </>
          ) : item.kind === 'message' ? (
            <>
              <span className="bk-author">{item.authorName}</span>
              <span className="bk-text">{item.snippet || '(no text)'}</span>
            </>
          ) : (
            <>
              <span className="bk-title" data-testid="bookmark-file-name">{item.name}</span>
              <span className="bk-meta">{fileMetaOf(item)}</span>
            </>
          )}
        </button>
      ) : (
        <div className="bk-open bk-gone" tabIndex={0} onKeyDown={onKey} data-testid="bookmark-gone">
          <span className="bk-text">No longer available</span>
        </div>
      )}
      <button type="button" className="btn s bk-remove" onClick={onRemove} data-testid="bookmark-remove" aria-label={item ? `Remove bookmark: ${nameOf(b)}` : 'Remove bookmark'}>
        Remove
      </button>
    </li>
  );
}

export function BookmarksScreen() {
  const [params, setParams] = useSearchParams();
  const tab = tabFrom(params.get('tab'));
  const supported = useBookmarksSupported();
  const openMessage = useOpenMessage();
  const navigate = useNavigate();
  const panel = usePanel();
  const go = (to: BookmarkOpen | null): void => {
    if (!to) return;
    // a bookmark lands on the message itself: a reply highlighted in its thread, a message of a chat with a bot in that chat
    if (to.type === 'message') void openMessage(to.target, [], { land: true });
    else if (to.type === 'href') void navigate(to.to);
    else panel.replace(to.entry);
  };
  const [extra, setExtra] = useState<{ tab: BookmarkTabId; items: SavedBookmark[]; cursor: string | null; busy: boolean } | null>(null);
  // removed here (waiting for the server, or confirmed but still in an answer on screen), and brought back by Undo (old id to the new bookmark)
  const [gone, setGone] = useState<ReadonlyMap<string, PageRemoval>>(new Map());
  const [swap, setSwap] = useState<ReadonlyMap<string, SavedBookmark>>(new Map());
  // each answer remembers when it was asked for, so the count knows which removals it already left out
  // (and which tab it is for: while the next tab loads, the last answer is not shown under it)
  const list = useQuery<ListSavedBookmarksResponse & { askedAt: number; tab: BookmarkTabId }>(`bookmarks:${tab}`, () => {
    const askedAt = Date.now();
    return fetchSavedBookmarks(tab).then((r) => ({ ...r, askedAt, tab }));
  });
  const listRef = useRef<HTMLUListElement>(null);
  const { reload } = list;

  useEffect(() => {
    void bookmarksStore.load();
  }, []);
  // another tab changed a bookmark: read the list again
  useEffect(() => bookmarksStore.onChange(() => reload()), [reload]);
  useEffect(() => {
    setExtra(null);
    setGone(new Map());
    setSwap(new Map());
  }, [tab]);

  const first = list.status === 'ok' && list.data.tab === tab ? list.data : null;
  const more = extra?.tab === tab ? extra : null;
  const pages = [first?.items ?? [], more?.items ?? []];
  const items = shownBookmarks(pages, gone, swap);
  const cursor = more ? more.cursor : (first?.nextCursor ?? null);
  const counts = first?.counts ?? null;
  const countOf = (id: BookmarkTabId): number | null => (counts && first ? (id === tab ? shownCount(counts[id], first.askedAt, pages, gone, swap) : counts[id]) : null);

  const showMore = async (): Promise<void> => {
    if (!cursor) return;
    setExtra((x) => ({ tab, items: x?.tab === tab ? x.items : [], cursor, busy: true }));
    try {
      const page = await fetchSavedBookmarks(tab, cursor);
      setExtra((x) => ({ tab, items: [...(x?.tab === tab ? x.items : []), ...page.items], cursor: page.nextCursor, busy: false }));
    } catch {
      setExtra((x) => (x ? { ...x, busy: false } : x));
    }
  };

  const without = (map: ReadonlyMap<string, PageRemoval>, id: string): ReadonlyMap<string, PageRemoval> => {
    const next = new Map(map);
    next.delete(id);
    return next;
  };
  const remove = useCallback(async (b: SavedBookmark): Promise<void> => {
    setGone((g) => new Map(g).set(b.id, { confirmedAt: null }));
    try {
      await bookmarksStore.remove(b.id);
      // confirmed: an answer asked for from now on leaves it out of its count
      setGone((g) => (g.has(b.id) ? new Map(g).set(b.id, { confirmedAt: Date.now() }) : g));
      // something no longer available (or a repository file no longer at its path) cannot be bookmarked again, so it has no Undo
      if (!canUndoRemoval(b)) {
        sayToast('Bookmark removed', { testId: 'bookmark-toast' });
        return;
      }
      sayToast('Bookmark removed', {
        testId: 'bookmark-toast',
        ms: UNDO_MS,
        undo: async () => {
          try {
            const back = await bookmarksStore.restore(b.target);
            // in its old place under its new id, once
            setSwap((m) => new Map(m).set(b.id, back));
            // its row (the old id) now stands for the new bookmark, in the same place; the count of the answer on screen still holds it, so it stays right
            setGone((g) => without(g, b.id));
          } catch (e) {
            sayToast(bookmarkErrorText(e));
          }
        },
      });
    } catch (e) {
      setGone((g) => without(g, b.id));
      sayToast(bookmarkErrorText(e));
    }
  }, []);

  const focusRow = (index: number): void => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.bk-open');
    rows?.[Math.max(0, Math.min(index, rows.length - 1))]?.focus();
  };
  const onKey = (index: number, b: SavedBookmark) => (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(index + 1);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(index - 1);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      void remove(b);
      focusRow(index);
    }
  };
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const at = BOOKMARK_TABS.findIndex((t) => t.id === tab);
    const next = BOOKMARK_TABS[(at + (e.key === 'ArrowRight' ? 1 : BOOKMARK_TABS.length - 1)) % BOOKMARK_TABS.length]!;
    setParams({ tab: next.id }, { replace: true });
    requestAnimationFrame(() => document.getElementById(`bk-tab-${next.id}`)?.focus());
  };

  const empty = first !== null && items.length === 0;
  return (
    <div className="bk-screen" data-testid="bookmarks-screen">
      <PageHeader title="Bookmarks" description={supported ? 'Threads, messages and files you keep to find again. Only you see them.' : 'Bookmarks are not available on this server.'} />
      <div className="bk-body">
        <div className="tabs2 bk-tabs" role="tablist" aria-label="Bookmarks">
          {BOOKMARK_TABS.map((t) => {
            const n = countOf(t.id);
            return (
              <button
                key={t.id}
                id={`bk-tab-${t.id}`}
                type="button"
                role="tab"
                className={tab === t.id ? 'on' : ''}
                aria-selected={tab === t.id}
                aria-controls="bk-panel"
                tabIndex={tab === t.id ? 0 : -1}
                data-testid={`bookmarks-tab-${t.id}`}
                onKeyDown={onTabKey}
                onClick={() => setParams({ tab: t.id }, { replace: true })}
              >
                {t.label}
                {n !== null ? <span data-testid={`bookmarks-count-${t.id}`}>{` · ${String(n)}`}</span> : null}
              </button>
            );
          })}
        </div>
        <div id="bk-panel" role="tabpanel" aria-labelledby={`bk-tab-${tab}`} className="bk-panel">
          {list.status !== 'error' && first === null ? <p className="bk-note" aria-busy="true">Loading…</p> : null}
          {list.status === 'error' ? (
            <div className="bk-note" role="alert">
              <p>Could not load your bookmarks.</p>
              <button type="button" className="btn s" onClick={reload}>Try again</button>
            </div>
          ) : null}
          {empty ? (
            <div className="bk-empty" data-testid="bookmarks-empty">
              <BookmarkToggleIcon size={20} />
              <p className="bk-empty-title">{EMPTY_TEXT[tab].title}</p>
              <p className="bk-empty-body">{EMPTY_TEXT[tab].body}</p>
            </div>
          ) : null}
          {items.length > 0 ? (
            <ul className="bk-list" ref={listRef} aria-label={LIST_LABEL[tab]}>
              {items.map((b, i) => (
                <Row key={b.id} b={b} onOpen={() => go(openOf(b))} onRemove={() => void remove(b)} onKey={onKey(i, b)} />
              ))}
            </ul>
          ) : null}
          {cursor ? (
            <button type="button" className="btn s bk-more" disabled={more?.busy === true} onClick={() => void showMore()} data-testid="bookmarks-more">
              {more?.busy ? 'Loading…' : 'Show more'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
