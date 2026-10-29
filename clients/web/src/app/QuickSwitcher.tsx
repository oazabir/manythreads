import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { BotSummary, RosterMember, SearchFileHit, Task } from '@manythreads/shared';
import { fetchBots } from '../screens/bots/api';
import { fetchColumnTasks } from '../screens/boards/api';
import { fetchPageEntries, fetchRoster, fetchTeam, searchEverything } from '../api/endpoints';
import { channelStore } from '../channels/store';
import { Dialog } from '../components/Dialog';
import { openConversation, useDms } from '../dms/store';
import { LockIcon } from '../shell/icons';
import { findChannel, useChannelFeed } from '../shell/channelFeed';
import { recalledTeam } from '../shell/views';
import { PANEL_PARAM } from '../kernel/panel';
import { markConversationRead, markEverythingRead } from './readAll';
import { useSession } from './session';
import {
  botItems,
  cardItems,
  channelItems,
  dmItems,
  fileItems,
  isQuickSwitcherKey,
  nextIndex,
  nextUnreadStop,
  openConversationOf,
  pageItems,
  personItems,
  rankItems,
  sectionItems,
  switcherTeamSlug,
  typingIn,
  type SwitcherItem,
  type UnreadStop,
} from './quick-switcher';

type Mode = 'closed' | 'switcher' | 'sheet';

const LIST_ID = 'quick-switcher-list';
const optionId = (i: number): string => `quick-switcher-option-${i}`;
const NOTE_MS = 2_500;

/** What the switcher can search beyond the sidebar's own lists; each source is optional (a guest or a server without the plugin answers nothing). */
type Sources = { people: readonly RosterMember[]; bots: readonly BotSummary[]; cards: readonly Task[]; pages: readonly { name: string; path: string; kind: string }[]; teamId: string | null };
const NO_SOURCES: Sources = { people: [], bots: [], cards: [], pages: [], teamId: null };

/** Loads the lists once each time the switcher opens; a list that cannot be read stays empty. */
function useSources(slug: string | null, on: boolean, guest: boolean): Sources {
  // kept with the team they were read for: after a switch to another team the old team's people, bots and cards must not be offered
  const [held, setSources] = useState<{ slug: string; sources: Sources } | null>(null);
  useEffect(() => {
    if (!on || !slug || guest) return;
    let live = true;
    void Promise.allSettled([fetchRoster(slug), fetchBots(slug), fetchColumnTasks(slug, { limit: 100 }), fetchPageEntries(slug), fetchTeam(slug)]).then(([roster, bots, cards, pages, team]) => {
      if (!live) return;
      setSources({
        slug,
        sources: {
          people: roster.status === 'fulfilled' ? roster.value.members : [],
          bots: bots.status === 'fulfilled' ? bots.value.bots : [],
          cards: cards.status === 'fulfilled' ? cards.value.items : [],
          pages: pages.status === 'fulfilled' ? pages.value.entries : [],
          teamId: team.status === 'fulfilled' ? team.value.team.id : null,
        },
      });
    });
    return () => {
      live = false;
    };
  }, [on, slug, guest]);
  return held && held.slug === slug ? held.sources : NO_SOURCES;
}

/** Attachments whose name carries the query, asked of the search a moment after the last key. */
function useFileHits(on: boolean, query: string): readonly SearchFileHit[] {
  const [hits, setHits] = useState<readonly SearchFileHit[]>([]);
  const q = query.trim().replace(/^#/, '');
  useEffect(() => {
    if (!on || q.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      searchEverything(q, { scope: 'files', limit: 8 }).then(
        (res) => live && setHits(res.files),
        () => live && setHits([]),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [on, q]);
  return hits;
}

/** True while a menu, dialog or popover is open: the Esc key belongs to it. */
const somethingOpen = (): boolean => document.querySelector('[role="dialog"], [role="menu"], [aria-modal="true"], .menu, .vpop') !== null;

/**
 * The keyboard of the signed-in app (PLAN P14-10), mounted once inside RequireSession.
 * - Ctrl/Cmd+K: a search over the team's channels, direct messages, people, bots, pages, board cards and files, and its own screens; arrows move,
 *   Enter opens, Esc closes.
 * - Alt+Down and Alt+Up: the next and the previous conversation with unread messages.
 * - Esc, outside a text field and with nothing else open: marks the open conversation read; Shift+Esc marks everything read.
 * - `?` outside a text field: the list of these shortcuts.
 */
export function QuickSwitcher() {
  const navigate = useNavigate();
  const loc = useLocation();
  const session = useSession();
  const guest = session.role === 'guest';
  const slug = switcherTeamSlug(loc.pathname, guest, recalledTeam());
  const feed = useChannelFeed(slug);
  const dms = useDms(!guest);
  const [mode, setMode] = useState<Mode>('closed');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const sources = useSources(slug, mode === 'switcher', guest);
  const fileHits = useFileHits(mode === 'switcher', query);

  const all = useMemo<SwitcherItem[]>(() => {
    if (!slug) return [];
    const me = session.person.id;
    return [
      ...channelItems(feed.groups, slug),
      ...dmItems(dms.items, me, slug),
      ...personItems(sources.people, me),
      ...botItems(sources.bots, slug),
      ...sectionItems(slug, guest),
      ...pageItems(sources.pages, slug),
      ...cardItems(sources.cards, slug),
      ...fileItems(fileHits, slug, sources.teamId),
    ];
  }, [slug, feed.groups, dms.items, sources, fileHits, guest, session.person.id]);
  const results = useMemo(() => rankItems(all, query), [all, query]);
  const selected = results[active];

  // Everything the keys below read at the moment of the press, held in one ref so the listener is attached once.
  const latest = useRef({ slug, feed, dms, pathname: loc.pathname });
  latest.current = { slug, feed, dms, pathname: loc.pathname };

  const say = useCallback((text: string): void => {
    setNote(text);
  }, []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  const open = useCallback((what: Exclude<Mode, 'closed'>): void => {
    setQuery('');
    setActive(0);
    setMode(what);
  }, []);
  const close = useCallback((): void => setMode('closed'), []);

  useEffect(() => {
    const unreadJump = (dir: 1 | -1): void => {
      const { slug: team, feed: f, dms: d, pathname } = latest.current;
      if (!team) return;
      const here = openConversationOf(pathname);
      const channels = channelItems(f.groups, team);
      const stops: UnreadStop[] = [
        ...channels.map((c) => ({ id: c.key.slice('channel:'.length), to: c.to ?? '' })),
        ...dmItems(d.items, session.person.id, team).map((x) => ({ id: x.key.slice('dm:'.length), to: x.to ?? '' })),
      ];
      const currentId = here?.kind === 'dm' ? here.id : here?.kind === 'channel' ? (findChannel(f.groups, here.name)?.id ?? null) : null;
      const stop = nextUnreadStop(stops, channelStore.snapshot().unread, currentId, dir);
      if (stop) navigate(stop.to);
      else say('Nothing else is unread.');
    };
    const readOpen = (): void => {
      const { feed: f, pathname } = latest.current;
      const here = openConversationOf(pathname);
      const id = here?.kind === 'dm' ? here.id : here?.kind === 'channel' ? findChannel(f.groups, here.name)?.id : undefined;
      if (!id) return;
      void markConversationRead(id).then(
        () => say(here?.kind === 'channel' ? `#${here.name} marked as read.` : 'Conversation marked as read.'),
        () => say('Could not mark it as read.'),
      );
    };
    const readAll = (): void => {
      const { slug: team } = latest.current;
      if (!team) return;
      void markEverythingRead(team).then(
        (n) => say(n === 0 ? 'Nothing was unread.' : 'Everything marked as read.'),
        () => say('Could not mark everything as read.'),
      );
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      if (isQuickSwitcherKey(e)) {
        e.preventDefault();
        if (modeRef.current === 'switcher') close();
        else open('switcher');
        return;
      }
      if (modeRef.current !== 'closed') return;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === '?' && plain && !typingIn(document.activeElement)) {
        e.preventDefault();
        open('sheet');
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        unreadJump(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Escape' && !e.repeat && plain && !typingIn(document.activeElement) && !somethingOpen() && !new URLSearchParams(window.location.search).has(PANEL_PARAM)) {
        e.preventDefault();
        if (e.shiftKey) readAll();
        else readOpen();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, open, navigate, say, session.person.id]);

  // The active row can fall out of view on a long list: keep it visible, like the sidebar does for its selection.
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, results.length]);

  const go = useCallback(
    (it: SwitcherItem): void => {
      close();
      if (it.to) {
        navigate(it.to);
        return;
      }
      if (it.personId && slug) {
        openConversation([it.personId]).then(
          (dm) => navigate(`/t/${encodeURIComponent(slug)}/dm/${dm.channel.id}`),
          () => say('Could not open that conversation.'),
        );
      }
    },
    [close, navigate, say, slug],
  );

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => nextIndex(results.length, i, e.key));
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      go(selected);
    }
  };

  const status = note ? (
    <p className="qs-note" role="status" data-testid="quick-switcher-note">
      {note}
    </p>
  ) : null;

  if (mode === 'closed') return status;

  if (mode === 'sheet') {
    return (
      <>
        {status}
        <Dialog title="Keyboard shortcuts" onClose={close} testId="shortcut-sheet" sheet>
          <div className="qs-sheet">
            <h3>Jump</h3>
            <dl>
              <dt><kbd className="qs-kbd">Ctrl/Cmd+K</kbd></dt>
              <dd>Jump to a channel, person, bot, page, card or file</dd>
              <dt><kbd className="qs-kbd">Alt+↓</kbd> <kbd className="qs-kbd">Alt+↑</kbd></dt>
              <dd>Next or previous conversation with unread messages</dd>
            </dl>
            <h3>Reading</h3>
            <dl>
              <dt><kbd className="qs-kbd">Esc</kbd></dt>
              <dd>Mark the open conversation as read (outside a text box)</dd>
              <dt><kbd className="qs-kbd">Shift+Esc</kbd></dt>
              <dd>Mark everything as read</dd>
              <dt><kbd className="qs-kbd">j</kbd> <kbd className="qs-kbd">k</kbd> <kbd className="qs-kbd">e</kbd></dt>
              <dd>In Threads: move down or up, mark the thread read</dd>
            </dl>
            <h3>Help</h3>
            <dl>
              <dt><kbd className="qs-kbd">?</kbd></dt>
              <dd>This shortcut list</dd>
            </dl>
          </div>
        </Dialog>
      </>
    );
  }

  const loading = feed.status === 'loading' && all.length === 0;
  return (
    <>
      {status}
      <Dialog title="Jump to…" onClose={close} testId="quick-switcher">
        <input
          className="dlg-input"
          data-autofocus
          data-testid="quick-switcher-search"
          role="combobox"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-activedescendant={selected ? optionId(active) : undefined}
          aria-label="Search channels, people, bots, pages, cards and files"
          placeholder="Type a name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onSearchKey}
        />
        {loading ? (
          <p className="dlg-hint" aria-busy="true">Loading…</p>
        ) : results.length === 0 ? (
          <p className="dlg-hint">{all.length === 0 ? 'There is nothing to jump to yet.' : 'Nothing has that name.'}</p>
        ) : (
          <ul id={LIST_ID} role="listbox" aria-label="Results" data-testid="quick-switcher-list" className="qs-list">
            {results.map((c, i) => (
              <li
                key={c.key}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                data-testid="quick-switcher-option"
                data-kind={c.kind}
                className="qs-row"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(c)}
              >
                <span aria-hidden="true" className="qs-mark">{c.kind === 'channel' ? (c.isPrivate ? <LockIcon /> : '#') : null}</span>
                <span className="qs-label">{c.label}</span>
                <span className="qs-hint">{c.hint}</span>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
