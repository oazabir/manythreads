import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ThreadInboxItem } from '@manythreads/shared';
import { LaterTab, type LaterView } from '../later/LaterPanes';
import { useLater } from '../later/RemindMenu';
import { laterStore } from '../later/store';
import { isApiError } from '../api/client';
import { fetchThread, fetchThreadInbox } from '../api/endpoints';
import { typingIn } from '../app/quick-switcher';
import { useQuery } from '../app/useQuery';
import { ThreadBody } from '../channels/ThreadPanel';
import { useUnread } from '../channels/hooks';
import { channelStore, threadKey } from '../channels/store';
import { useShell } from '../shell/context';
import { useNarrow } from '../shell/useNarrow';
import { Bell } from '../notifications/Bell';
import { BackIcon, ReplyIcon } from '../shell/icons';
import { WelcomeCard } from '../welcome/WelcomeCard';
import { PageHeader } from '../components/PageHeader';
import { ThreadCard } from './ThreadCard';
import { groupThreads } from './threadCard';
import { FilterBar } from '../inbox/FilterBar';
import { NOT_NEEDED, filterThreads, mentionsParam, mergeFiltered, needsYou, orderThreads, parseFilter, resolveNames, type NeedsYou } from '../inbox/rules';
import { useInboxWork } from '../inbox/useInboxWork';
import { usePeople } from '../channels/hooks';
import { EmptyState, type EmptyStateAction } from '../components/EmptyState';
import { SkeletonRows } from '../components/Skeleton';

type Tab = 'followed' | 'unread' | 'mine' | 'later';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'followed', label: 'Followed' },
  { id: 'unread', label: 'Unread' },
  { id: 'mine', label: 'Mine' },
  { id: 'later', label: 'Later' },
];
const EMPTY: Record<Tab, { title: string; body: string }> = {
  followed: { title: 'No threads yet', body: 'Threads you follow or start show up here.' },
  unread: { title: 'You are all caught up', body: 'Replies you have not read show up here.' },
  mine: { title: 'No threads of yours yet', body: 'Threads you start show up here.' },
  later: { title: 'Nothing saved for later', body: 'Messages you save or ask to be reminded of show up here.' },
};
/** One suggestion under each empty state. */
const SUGGEST: Record<Tab, string> = { followed: 'Press Ctrl K to find a channel and join in.', unread: 'Press Ctrl K to find a channel and join in.', mine: 'Reply in a channel to start a thread.', later: 'Save a message from its menu.' };
/** The one thing to do next under each empty tab: find somewhere to talk, or go back to the tab that has the threads. */
const ACTION = (slug: string): Record<Tab, EmptyStateAction> => ({
  followed: { label: 'Find a channel', to: `/t/${slug}/search` },
  unread: { label: 'See followed threads', to: `/t/${slug}/threads` },
  mine: { label: 'Find a channel', to: `/t/${slug}/search` },
  later: { label: 'See followed threads', to: `/t/${slug}/threads` },
});
const NO_THREADS = { items: [] as ThreadInboxItem[], nextCursor: null as string | null };
const NO_WORDS: readonly string[] = [];
/** The filter asks the server this long after the last key. */
const FILTER_DELAY_MS = 250;

const tabOf = (raw: string | null): Tab => (raw === 'unread' || raw === 'mine' || raw === 'later' ? raw : 'followed');

/** The Threads inbox (SPEC 6.1): Followed · Unread · Mine · Later (saved messages and reminders, PLAN P14-04) on the left, the selected thread on the right. j and k move, e marks it read. */
export function ThreadsInbox() {
  const { team } = useShell();
  const slug = team?.slug ?? '';
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const path = useLocation().pathname;
  const narrow = useNarrow();
  const later = useLater();
  // a server without the reminders plugin has no Later tab: a link to it shows the first tab
  const tabAsked = tabOf(params.get('tab'));
  const tab: Tab = tabAsked === 'later' && !later.supported ? 'followed' : tabAsked;
  // on the Later tab the selection is a saved item (`?item=`), on the others a thread (`?thread=`)
  const selected = params.get(tab === 'later' ? 'item' : 'thread');
  const laterView: LaterView = params.get('view') === 'done' ? 'done' : 'open';
  const { threadsUnread } = useUnread();
  const people = usePeople();
  const q = useQuery(`inbox:${slug}:${tab}:${threadsUnread}`, () => (tab === 'later' ? Promise.resolve(NO_THREADS) : fetchThreadInbox(slug, tab)));
  useEffect(() => {
    void laterStore.load(true);
  }, [tab]);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);

  // "Show more": the pages after the first, read by cursor and kept until the tab or the team changes
  const pageKey = `${slug}:${tab}`;
  const [more, setMore] = useState<{ key: string; items: ThreadInboxItem[]; cursor: string | null; busy: boolean; failed: boolean }>({ key: '', items: [], cursor: null, busy: false, failed: false });
  const extra = more.key === pageKey ? more : null;
  const firstPage = q.status === 'ok' ? q.data : null;
  const nextCursor = extra ? extra.cursor : (firstPage?.nextCursor ?? null);
  const showMore = useCallback(async (): Promise<void> => {
    const cursor = extra ? extra.cursor : firstPage?.nextCursor;
    if (!cursor || tab === 'later') return;
    setMore((m) => ({ key: pageKey, items: m.key === pageKey ? m.items : [], cursor, busy: true, failed: false }));
    try {
      const page = await fetchThreadInbox(slug, tab, cursor);
      setMore((m) => ({ key: pageKey, items: [...(m.key === pageKey ? m.items : []), ...page.items], cursor: page.nextCursor, busy: false, failed: false }));
    } catch {
      setMore((m) => ({ key: pageKey, items: m.key === pageKey ? m.items : [], cursor, busy: false, failed: true }));
    }
  }, [extra, firstPage, tab, slug, pageKey]);

  // The thread being read stays on the Unread list while it is open, even though reading it just emptied its count there.
  const shown = useRef<ThreadInboxItem[]>([]);
  const loaded = useMemo<ThreadInboxItem[]>(() => {
    if (q.status !== 'ok') return shown.current;
    const head = q.data.items;
    const seen = new Set(head.map((i) => i.rootMessageId));
    const all = [...head, ...(extra?.items ?? []).filter((i) => !seen.has(i.rootMessageId))];
    const fresh = all.filter((i) => !(tab === 'unread' && done.has(i.rootMessageId)));
    if (tab === 'unread' && selected && !done.has(selected) && !fresh.some((i) => i.rootMessageId === selected)) {
      const was = shown.current.findIndex((i) => i.rootMessageId === selected);
      const row = shown.current[was];
      if (row) return [...fresh.slice(0, was), { ...row, unreadCount: 0 }, ...fresh.slice(was)];
    }
    return fresh;
  }, [q, tab, done, selected, extra]);
  useEffect(() => {
    shown.current = loaded;
  }, [loaded]);

  // ---- the filter: the words of the box are kept in `?q=`; the loaded rows answer at once, the server answers for the rest and for `@name` ----
  const urlQ = params.get('q') ?? '';
  const [text, setText] = useState(urlQ);
  useEffect(() => setText((t) => (t === urlQ ? t : urlQ)), [urlQ]);
  const changeFilter = useCallback(
    (next: string): void => {
      setText(next);
      const sp = new URLSearchParams(window.location.search);
      if (next.trim() === '') sp.delete('q');
      else sp.set('q', next);
      setParams(sp, { replace: true });
    },
    [setParams],
  );
  const [typed, setTyped] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setTyped(text), text.trim() === '' ? 0 : FILTER_DELAY_MS);
    return () => clearTimeout(t);
  }, [text]);
  const parsed = useMemo(() => parseFilter(text), [text]);
  const parsedTyped = useMemo(() => parseFilter(typed), [typed]);
  const filtering = tab !== 'later' && !parsed.empty;
  const roster = useMemo(() => ({ people: people.list, bots: people.botActors ?? [] }), [people.list, people.botActors]);
  const named = useMemo(() => resolveNames(parsedTyped.names, roster), [parsedTyped.names, roster]);
  const rawWords = useMemo(() => typed.trim().split(/\s+/).filter((w) => w !== '' && !w.startsWith('@')).slice(0, 6).join(' '), [typed]);
  const askServer = filtering && !parsedTyped.empty && named.unmatched.length === 0 && people.settled;
  const serverKey = askServer ? `${slug}:${tab}:${rawWords}:${mentionsParam(named.groups) ?? ''}` : null;
  const sq = useQuery<{ key: string | null; items: ThreadInboxItem[] }>(`inbox-q:${serverKey ?? 'off'}:${threadsUnread}`, () =>
    serverKey === null ? Promise.resolve({ key: null, items: [] }) : fetchThreadInbox(slug, tab as 'followed' | 'unread' | 'mine', undefined, { ...(rawWords ? { q: rawWords } : {}), ...(mentionsParam(named.groups) ? { mentions: mentionsParam(named.groups) } : {}) }).then((r) => ({ key: serverKey, items: r.items })),
  );
  const serverRows = serverKey !== null && sq.status === 'ok' && sq.data.key === serverKey ? sq.data.items : null;
  const serverError = serverKey !== null && sq.status === 'error';
  const words = filtering ? parsed.words : NO_WORDS;
  const unmatchedName = filtering && parsed.names.length > 0 && people.settled && resolveNames(parsed.names, roster).unmatched.length > 0;
  const rowsBase = useMemo<ThreadInboxItem[]>(() => {
    if (!filtering) return loaded;
    if (unmatchedName) return [];
    const local = filterThreads(loaded, parsed.words);
    if (parsed.names.length > 0) return serverRows ?? [];
    return serverRows ? mergeFiltered(serverRows, local) : local;
  }, [filtering, loaded, parsed, serverRows, unmatchedName]);
  const searching = filtering && !unmatchedName && !serverError && serverRows === null && (parsed.names.length > 0 || parsed.words.length > 0);

  // ---- what goes on in the listed threads, and which rows need the person ----
  const workOf = useInboxWork(useMemo(() => rowsBase.slice(0, 200).map((r) => r.rootMessageId), [rowsBase]));
  const needsFirst = params.get('order') !== 'time';
  const setNeedsFirst = useCallback(
    (on: boolean): void => {
      const sp = new URLSearchParams(window.location.search);
      if (on) sp.delete('order');
      else sp.set('order', 'time');
      setParams(sp, { replace: true });
    },
    [setParams],
  );
  const needsMap = useMemo(() => {
    const m = new Map<string, NeedsYou>();
    for (const r of rowsBase) m.set(r.rootMessageId, needsYou(r, workOf(r.rootMessageId).questions));
    return m;
  }, [rowsBase, workOf]);
  const needsOf = useCallback((root: string): NeedsYou => needsMap.get(root) ?? NOT_NEEDED, [needsMap]);
  // a filtered list keeps its own order (channel-name matches first), so it has neither the Needs-you group nor the day groups; the chips still show
  const ordered = useMemo(() => orderThreads(rowsBase, needsOf, filtering || !needsFirst ? 'time' : 'needs'), [rowsBase, needsOf, needsFirst, filtering]);
  const items = useMemo(() => [...ordered.needs, ...ordered.rest], [ordered]);
  const groups = useMemo(() => (filtering ? [] : groupThreads(ordered.rest, new Date())), [ordered.rest, filtering]);
  const absent = q.status === 'error' && isApiError(q.error) && q.error.status === 404;

  const open = useCallback(
    (rootId: string | null, replace = false): void => {
      const next = new URLSearchParams(params);
      const key = tab === 'later' ? 'item' : 'thread';
      if (rootId) next.set(key, rootId);
      else next.delete(key);
      setParams(next, { replace });
    },
    [params, setParams, tab],
  );
  const setTab = (t: Tab): void => {
    const next = new URLSearchParams(params);
    if (t === 'followed') next.delete('tab');
    else next.set('tab', t);
    next.delete('thread');
    next.delete('item');
    next.delete('view');
    setParams(next);
  };

  // On a wide screen the first thread is open, as in the prototype (not on Unread: opening reads it, so the person chooses).
  // The list arrives after a moment: by then the person may have gone elsewhere or opened a panel, so the live location decides, never the
  // location this render saw (a late replace would otherwise pull them back to Threads, or drop the panel they just opened).
  const first = items[0]?.rootMessageId ?? null;
  useEffect(() => {
    if (narrow || selected || tab === 'unread' || !first) return;
    if (window.location.pathname !== path) return;
    const live = new URLSearchParams(window.location.search);
    if (live.get('thread')) return;
    live.set('thread', first);
    const state = (window.history.state as { usr?: unknown } | null)?.usr ?? null;
    navigate({ pathname: path, search: `?${live.toString()}` }, { replace: true, state });
  }, [narrow, selected, tab, first, path, navigate]);

  const markDone = useCallback(
    (rootId: string): void => {
      const tl = channelStore.get(threadKey(rootId));
      const upTo = tl.items.at(-1)?.id ?? rootId;
      void channelStore.markRead('thread', rootId, upTo);
      setDone((s) => new Set(s).add(rootId));
    },
    [],
  );

  // From a row's Actions menu: the thread may not be open, so its newest reply is asked for when the timeline has not got it
  const markThreadRead = useCallback(
    async (rootId: string): Promise<void> => {
      const held = channelStore.get(threadKey(rootId)).items.at(-1)?.id;
      const upTo = held ?? (await fetchThread(rootId, { limit: 1 })).replies.items[0]?.id ?? rootId;
      await channelStore.markRead('thread', rootId, upTo);
      setDone((s) => new Set(s).add(rootId));
      q.reload();
    },
    [q],
  );

  // A layout effect: the listener is swapped in the same commit that paints the new selection. A passive effect ran later, and a key pressed in
  // between (j, j, k, e one after the other, on a loaded machine) acted on the thread selected two renders ago.
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (tab === 'later' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
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

  const onOpenRow = useCallback((rootId: string): void => {
    open(rootId);
  }, [open]);
  const onOpenInChannel = useCallback((to: string): void => {
    void navigate(to);
  }, [navigate]);
  const card = (it: ThreadInboxItem): ReactNode => (
    <ThreadCard
      key={it.rootMessageId}
      item={it}
      teamSlug={slug}
      selected={it.rootMessageId === selected}
      onOpen={onOpenRow}
      onMarkRead={markThreadRead}
      onChanged={q.reload}
      onOpenInChannel={onOpenInChannel}
      words={words}
      work={workOf(it.rootMessageId)}
      needs={needsOf(it.rootMessageId)}
    />
  );
  const filterStatus = !filtering
    ? null
    : unmatchedName
      ? `No one is called @${resolveNames(parsed.names, roster).unmatched.join(', @')}`
      : searching
        ? 'Searching…'
        : serverError
          ? 'Could not search every thread; showing the ones loaded'
          : `${items.length} ${items.length === 1 ? 'thread matches' : 'threads match'}`;

  const showMain = !narrow || selected !== null;
  // with no thread open the right band still carries the bell, which the shell's own band would have held
  const emptyBand = !narrow && !selected ? <div className="chead thread-head" /> : null;
  const showList = !narrow || selected === null;
  // the tabs, shared by the thread tabs and Later; Later's badge counts the reminders that are due
  const header = (
    <header className="inh" data-landmark={narrow ? undefined : 'header'}>
      {narrow ? null : <PageHeader compact title="Threads" />}
      <div className="tabs2" role="tablist" aria-label="Threads">
        {TABS.filter((t) => t.id !== 'later' || later.supported).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} data-testid={`tab-${t.id}`}>
            {t.label}
            {t.id === 'unread' && threadsUnread > 0 ? <span data-vt-mask>{` · ${threadsUnread}`}</span> : null}
            {(t.id === 'followed' || t.id === 'mine') && tab === t.id && q.status === 'ok' && loaded.length > 0 ? <span data-vt-mask data-testid={`${t.id}-count`}>{` · ${loaded.length}`}</span> : null}
            {t.id === 'later' && later.dueCount > 0 ? <span data-vt-mask data-testid="later-due-count">{` · ${later.dueCount}`}</span> : null}
          </button>
        ))}
      </div>
    </header>
  );
  if (tab === 'later' && later.supported) {
    return (
      <div className="threads-home">
        <LaterTab
          header={header}
          narrow={narrow}
          view={laterView}
          setView={(v) => {
            const next = new URLSearchParams(params);
            if (v === 'done') next.set('view', 'done');
            else next.delete('view');
            next.delete('item');
            setParams(next);
          }}
          selected={selected}
          onSelect={(id) => open(id)}
          bell={narrow ? null : <div className="inr-bell"><Bell /></div>}
          backLabel="Threads"
        />
      </div>
    );
  }
  return (
    <div className="threads-home">
    <div className={`inbox ${narrow ? 'narrow' : ''}`} data-testid="threads-inbox">
      {showList ? (
        <div className="inl" data-landmark="thread-list">
          {header}
          {q.status === 'ok' && (loaded.length > 0 || filtering) ? (
            <FilterBar
              value={text}
              onChange={changeFilter}
              needsFirst={needsFirst}
              onNeedsFirst={setNeedsFirst}
              status={filterStatus}
            />
          ) : null}
          {q.status === 'loading' ? (
            <SkeletonRows rows={5} avatar label="Loading threads" />
          ) : absent || (q.status === 'ok' && loaded.length === 0 && !filtering) ? (
            <div className="inl-empty">
              <EmptyState icon={ReplyIcon} testId="threads-empty" title={EMPTY[tab].title} action={ACTION(slug)[tab]}>
                <p>{EMPTY[tab].body}</p>
                <p>{SUGGEST[tab]}</p>
              </EmptyState>
              {tab === 'followed' ? <WelcomeCard slug={slug} /> : null}
            </div>
          ) : q.status === 'error' ? (
            <div className="inl-empty" role="alert">
              <p className="view-empty-title">Could not load threads.</p>
              <button type="button" className="btn s" onClick={q.reload}>Try again</button>
            </div>
          ) : searching && items.length === 0 ? (
            <SkeletonRows rows={3} avatar label="Searching threads" />
          ) : items.length === 0 ? (
            <div className="inl-empty" data-testid="threads-filter-empty">
              <p className="view-empty-title">{unmatchedName ? 'Nobody has that name' : 'No threads match'}</p>
              <p className="view-empty-body">{unmatchedName ? 'Try a first name, or a bot’s name.' : 'Try fewer words, or clear the filter.'}</p>
              <button type="button" className="btn s" onClick={() => changeFilter('')}>Clear the filter</button>
            </div>
          ) : (
            <ul className="inlist" ref={listRef} role="listbox" aria-label={`${TABS.find((t) => t.id === tab)?.label ?? ''} threads`} aria-busy={searching}>
              {ordered.needs.length > 0 ? (
                <li role="presentation" className="thc-day thc-needs-h" data-testid="thread-needs-group">{`Needs you · ${ordered.needs.length}`}</li>
              ) : null}
              {ordered.needs.map((it) => card(it))}
              {filtering ? ordered.rest.map((it) => card(it)) : null}
              {groups.map((g) => (
                <Fragment key={g.day}>
                  <li role="presentation" className="thc-day" data-testid="thread-day">{ordered.needs.length > 0 && g.day === groups[0]?.day ? `${g.day} · everything else` : g.day}</li>
                  {g.items.map((it) => card(it))}
                </Fragment>
              ))}
              {nextCursor && !filtering ? (
                <li role="presentation" className="inl-more">
                  <button type="button" className="btn s" data-testid="threads-more" disabled={extra?.busy === true} onClick={() => void showMore()}>
                    {extra?.busy ? 'Loading…' : extra?.failed ? 'Could not load, try again' : 'Show more threads'}
                  </button>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      ) : null}
      {showMain ? (
        <div className="inr" data-landmark="thread-view">
          {narrow ? (
            <button type="button" className="btn s back-to-list" onClick={() => open(null)}>
              <BackIcon />
              <span>Threads</span>
            </button>
          ) : null}
          {narrow ? null : <div className="inr-bell"><Bell /></div>}
          {emptyBand}
          {selected ? (
            <ThreadBody key={selected} rootId={selected} variant="main" />
          ) : items.length > 0 ? (
            <div className="inr-empty">
              <p className="view-empty-title">Pick a thread</p>
              <p className="view-empty-body">Its messages show here. Press j and k to move, e to mark it read.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
    </div>
  );
}
