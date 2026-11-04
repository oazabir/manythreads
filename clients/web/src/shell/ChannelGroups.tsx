import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type RefObject } from 'react';
import { NavLink, useLocation } from 'react-router';
import { LiveBadge } from '../meetings/LiveBadge';
import { IDLE_CHANNEL_DAYS, type NavChannel, type SidebarPrefs } from '@manythreads/shared';
import { isAdmin, useSession } from '../app/session';
import { useUnread } from '../channels/hooks';
import { levelsStore } from '../notifications/levelsStore';
import { useShell } from './context';
import { useChannelFeed } from './channelFeed';
import { AddIcon, ArrowDownIcon, ArrowUpIcon, CaretIcon, LockIcon, MoreIcon, OptionsIcon, StarIcon } from './icons';
import { channelPath } from './nav';
import { NewChannelDialog } from './NewChannel';
import { canCreateChannel } from './newChannel';
import { Pill } from './Pill';
import { arrangeSidebar, dropId, FULL_STARS_TEXT, isStarred, moveId, reorderShown, shownGroupIds, starPatch, type ArrangedGroup, type ArrangedSidebar } from './sidebarLayout';
import { sidebarPrefsStore, useSidebarPrefs } from './sidebarPrefsStore';
import { unreadLook, type UnreadLook } from './unreadLook';
import { useDismiss } from './useDismiss';

/** The channel open now, from the address (`/t/<team>/c/<name>`), or null. */
export function openChannelName(pathname: string): string | null {
  const m = /^\/t\/[^/]+\/c\/([^/]+)/.exec(pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Arrow keys, Home and End move between the items of a menu; the first item gets focus when the menu opens; Tab closes the menu and carries on
 * from the button that opened it (a menu is one stop in the tab order, not a trap).
 */
function useMenuKeys(open: boolean, menu: RefObject<HTMLElement | null>, close: () => void): (e: KeyboardEvent) => void {
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [open, menu]);
  return (e) => {
    if (e.key === 'Tab') {
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };
}

/**
 * Closes an open menu when the sidebar around it is put away (the phone's drawer closing makes the sidebar inert): a menu left open there would
 * come back open, and report itself as expanded while nobody can reach it.
 */
function useCloseWhenSidebarLeaves(open: boolean, box: RefObject<HTMLElement | null>, close: () => void): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    const rail = open ? box.current?.closest('aside') : null;
    if (!rail) return;
    const watch = new MutationObserver(() => {
      if (rail.hasAttribute('inert')) closeRef.current();
    });
    watch.observe(rail, { attributes: true, attributeFilter: ['inert'] });
    return () => watch.disconnect();
  }, [open, box]);
}

/** Runs a change of the sidebar and shows its one plain-language error line if the server refuses it. */
type Report = (work: Promise<void>) => void;

/** Where keyboard focus goes once the list has been rearranged by a change (the element that had it may have moved or been replaced). */
type FocusTarget = { row: string } | { group: string } | { move: string; dir: -1 | 1 };
/** What to do once a change has been drawn: put focus back, and say in words what happened (for a screen reader). */
type Note = { focus?: FocusTarget; say?: string | ((arranged: ArrangedSidebar) => string) };
type Notify = (note: Note) => void;

const esc = (id: string): string => CSS.escape(id);

/** Puts focus on the element a change moved or replaced; when that element is no longer on screen, on the first group heading. */
function restoreFocus(root: HTMLElement | null, target: FocusTarget): void {
  if (!root) return;
  let el: HTMLElement | null = null;
  if ('row' in target) el = root.querySelector<HTMLElement>(`[data-sb-row="${esc(target.row)}"] > .it`);
  else if ('group' in target) el = root.querySelector<HTMLElement>(`[data-group="${esc(target.group)}"] .grp`);
  else {
    // a Move button that is now disabled (the group reached an end) hands focus to its sibling, so focus never sits on a disabled button
    const mine = root.querySelector<HTMLElement>(`button[data-ord-id="${esc(target.move)}"][data-ord-dir="${target.dir}"]:not(:disabled)`);
    el = mine ?? root.querySelector<HTMLElement>(`button[data-ord-id="${esc(target.move)}"]:not(:disabled)`);
  }
  (el ?? root.querySelector<HTMLElement>('.grp'))?.focus();
}

type RowProps = {
  slug: string;
  channel: NavChannel;
  count: number;
  look: UnreadLook;
  starred: boolean;
  /** Whether the person can arrange their sidebar (a guest cannot). */
  personal: boolean;
  stars: readonly string[];
  report: Report;
  notify: Notify;
  setProblem: (text: string | null) => void;
};

/** One channel of the list. A person who can arrange their sidebar also gets a menu on the row: a button shown on hover and focus (always shown on a touch screen). */
function ChannelRow({ slug, channel, count, look, starred, personal, stars, report, notify, setProblem }: RowProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (): void => {
    if (panel.current?.contains(document.activeElement)) button.current?.focus();
    setOpen(false);
  };
  useDismiss(open, close, box);
  useCloseWhenSidebarLeaves(open, box, close);
  const keys = useMenuKeys(open, panel, close);
  const name = channel.name.replace(/^#/, '');
  const toggleStar = (): void => {
    const patch = starPatch(stars, channel.id, !starred);
    close();
    if (!patch) {
      setProblem(FULL_STARS_TEXT);
      return;
    }
    notify({ focus: { row: channel.id }, say: starred ? `Removed the star from #${name}` : `Starred #${name}` });
    report(sidebarPrefsStore.update(slug, patch));
  };
  return (
    <div className={`sb-row ${open ? 'sb-open' : ''}`} ref={box} data-sb-row={channel.id}>
      <NavLink to={channelPath(slug, channel.name)} className={({ isActive }) => `it ${isActive ? 'on' : ''} ${look.bold ? 'unread' : ''}`} data-unread={count > 0 ? count : undefined}>
        <span className="h">{channel.isPrivate ? <LockIcon /> : '#'}</span>
        <span className="it-label">{name}</span>
        <LiveBadge channelId={channel.id} />
        {look.badge ? <Pill n={count} tone={look.badge} /> : null}
      </NavLink>
      {personal ? (
        <>
          <button
            type="button"
            ref={button}
            className="sb-more"
            aria-label={`Options for #${name}`}
            aria-haspopup="menu"
            aria-expanded={open}
            data-testid="channel-row-menu"
            onClick={() => setOpen((o) => !o)}
          >
            <MoreIcon />
          </button>
          {open ? (
            <div className="sb-menu" role="menu" aria-label={`Options for #${name}`} ref={panel} onKeyDown={keys}>
              <button type="button" role="menuitem" className="sb-item" data-testid="channel-row-star" onClick={toggleStar}>
                <span className="sb-ic"><StarIcon filled={starred} /></span>
                {starred ? 'Remove star' : 'Star channel'}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

type OptionsProps = {
  slug: string;
  prefs: SidebarPrefs;
  /** The groups in the order they are shown (not the Starred group, which always comes first). */
  groups: readonly { id: string; name: string }[];
  report: Report;
  notify: Notify;
  /** Moves a shown group one place up or down, keeping the places of the groups that are not shown. */
  onMove: (id: string, step: -1 | 1, note: Note) => void;
};

const SORT_LABEL = { team: 'Team order', recent: 'Recent activity', name: 'Name' } as const;
/** "1 quiet channel" / "3 quiet channels". */
const quiet = (n: number): string => `${n} quiet ${n === 1 ? 'channel' : 'channels'}`;

/** The small control in the header of the channel list: how to sort, whether to fold away quiet channels, and the order of the groups. */
function ListOptions({ slug, prefs, groups, report, notify, onMove }: OptionsProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (): void => {
    if (panel.current?.contains(document.activeElement)) button.current?.focus();
    setOpen(false);
  };
  useDismiss(open, close, box);
  useCloseWhenSidebarLeaves(open, box, close);
  const keys = useMenuKeys(open, panel, close);
  const move = (id: string, name: string, step: -1 | 1): void =>
    onMove(id, step, { focus: { move: id, dir: step }, say: `Moved group ${name} ${step < 0 ? 'up' : 'down'}` });
  return (
    <div className="sb-opts" ref={box}>
      <button type="button" ref={button} className="icon-btn sb-opts-btn" aria-label="Channel list options" aria-haspopup="menu" aria-expanded={open} data-testid="sidebar-options" onClick={() => setOpen((o) => !o)}>
        <OptionsIcon />
      </button>
      {open ? (
        <div className="sb-menu sb-menu-wide" role="menu" aria-label="Channel list options" ref={panel} onKeyDown={keys} data-testid="sidebar-options-menu">
          <p className="sb-menu-h" id="sb-sort-h">Sort channels by</p>
          <div role="group" aria-labelledby="sb-sort-h">
            {(['team', 'recent', 'name'] as const).map((sort) => (
              <button
                key={sort}
                type="button"
                role="menuitemradio"
                aria-checked={prefs.sort === sort}
                className="sb-item"
                data-testid={`sort-${sort}`}
                onClick={() => {
                  close();
                  if (prefs.sort === sort) return;
                  notify({ say: `Channels sorted by ${SORT_LABEL[sort].toLowerCase()}` });
                  report(sidebarPrefsStore.update(slug, { sort }));
                }}
              >
                <span className="sb-ic" aria-hidden="true">{prefs.sort === sort ? '✓' : ''}</span>
                {SORT_LABEL[sort]}
              </button>
            ))}
          </div>
          <hr className="sb-sep" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.hideIdle}
            className="sb-item"
            data-testid="hide-idle"
            onClick={() => {
              close();
              const on = !prefs.hideIdle;
              notify({
                say: (a) => {
                  if (!on) return 'Quiet channels are shown again';
                  const n = a.groups.reduce((sum, g) => sum + g.hidden.length, 0);
                  return n === 0 ? `No channel has been quiet for ${IDLE_CHANNEL_DAYS} days` : `${quiet(n)} hidden`;
                },
              });
              report(sidebarPrefsStore.update(slug, { hideIdle: on }));
            }}
          >
            <span className="sb-ic" aria-hidden="true">{prefs.hideIdle ? '✓' : ''}</span>
            Hide channels idle for {IDLE_CHANNEL_DAYS} days
          </button>
          {groups.length >= 2 ? (
            <>
              <hr className="sb-sep" />
              <p className="sb-menu-h">Order of groups</p>
              {groups.map((g, i) => (
                <div key={g.id} className="sb-ord">
                  <span className="sb-ord-name">{g.name}</span>
                  <button type="button" role="menuitem" className="sb-ord-btn" aria-label={`Move ${g.name} up`} disabled={i === 0} data-ord-id={g.id} data-ord-dir="-1" data-testid={`group-up-${i}`} onClick={() => move(g.id, g.name, -1)}>
                    <ArrowUpIcon />
                  </button>
                  <button type="button" role="menuitem" className="sb-ord-btn" aria-label={`Move ${g.name} down`} disabled={i === groups.length - 1} data-ord-id={g.id} data-ord-dir="1" data-testid={`group-down-${i}`} onClick={() => move(g.id, g.name, 1)}>
                    <ArrowDownIcon />
                  </button>
                </div>
              ))}
              <p className="sb-menu-hint" data-testid="group-keys-hint">
                Or select a group heading and press Alt with the up or down arrow key.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type DragState = { dragging: string | null; over: { id: string; after: boolean } | null };

type GroupProps = {
  group: ArrangedGroup;
  slug: string;
  open: boolean;
  onToggle: () => void;
  /** The group can be dragged to a new place (`null`: it cannot, as the Starred group). */
  drag: { state: DragState; start: (id: string, e: DragEvent) => void; over: (id: string, e: DragEvent) => void; drop: (id: string, e: DragEvent) => void; end: () => void; move: (id: string, name: string, step: -1 | 1) => void } | null;
  rowProps: (c: NavChannel) => RowProps;
  /** The hidden channels are shown. */
  revealed: boolean;
  onReveal: () => void;
};

function Group({ group, open, onToggle, drag, rowProps, revealed, onReveal }: GroupProps) {
  const over = drag?.state.over?.id === group.id ? drag.state.over : null;
  const hiddenCount = group.hidden.length;
  return (
    <div
      className={`group ${drag?.state.dragging === group.id ? 'sb-dragging' : ''} ${over ? (over.after ? 'sb-drop-after' : 'sb-drop-before') : ''}`}
      data-group={group.id}
      onDragOver={drag ? (e) => drag.over(group.id, e) : undefined}
      onDrop={drag ? (e) => drag.drop(group.id, e) : undefined}
    >
      <div className="sb-ghead">
        {drag ? (
          <span
            className="sb-grip"
            draggable
            aria-hidden="true"
            title="Drag to move this group"
            data-testid={`group-grip-${group.name}`}
            onDragStart={(e) => drag.start(group.id, e)}
            onDragEnd={drag.end}
          >
            <span />
          </span>
        ) : null}
        <button
          type="button"
          className="grp"
          aria-expanded={open}
          aria-keyshortcuts={drag ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
          onClick={onToggle}
          onKeyDown={
            drag
              ? (e) => {
                  // Alt + arrow moves the group; the options menu has the same two buttons for a pointer or a touch screen.
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    drag.move(group.id, group.name, e.key === 'ArrowUp' ? -1 : 1);
                  }
                }
              : undefined
          }
        >
          <span className="car"><CaretIcon open={open} /></span>
          {group.name}
        </button>
      </div>
      {open ? (
        <>
          {group.channels.map((c) => {
            const p = rowProps(c);
            return <ChannelRow key={c.id} {...p} />;
          })}
          {hiddenCount > 0 ? (
            <button type="button" className="it sb-hidden-row" aria-expanded={revealed} data-testid="hidden-channels" onClick={onReveal}>
              <span className="h"><CaretIcon open={revealed} /></span>
              <span className="it-label">{quiet(hiddenCount)} hidden</span>
            </button>
          ) : null}
          {revealed
            ? group.hidden.map((c) => {
                const p = rowProps(c);
                return <ChannelRow key={c.id} {...p} />;
              })
            : null}
        </>
      ) : null}
    </div>
  );
}

/** Slot 40 of the sidebar contract: the person's Starred group, then the team's channel groups in their order, each sorted their way. */
export function ChannelGroups({ slug, guest }: { slug: string; guest: boolean }) {
  const feed = useChannelFeed(slug);
  const { unread } = useUnread();
  const session = useSession();
  const { team } = useShell();
  const { pathname } = useLocation();
  const levels = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot).levels;
  const entry = useSidebarPrefs(slug, !guest);
  const { prefs } = entry;
  const personal = !guest && entry.status === 'ok';
  // The team the dialog was opened for: if the person moves to another team meanwhile, the dialog is gone rather than creating in the wrong one.
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  useEffect(() => setCreatingIn(null), [slug]);
  const mayCreate = !guest && canCreateChannel(team, isAdmin(session));
  // The person's notification levels decide how loudly an unread conversation shows (a muted one keeps a grey count, no bold label).
  useEffect(() => {
    if (!guest) void levelsStore.load();
  }, [guest]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const flip = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  // One line for a change the server refused; it goes away by itself, and with the next change that works.
  const [problem, setProblem] = useState<string | null>(null);
  const later = useRef<Note | null>(null);
  useEffect(() => {
    if (!problem) return;
    const t = setTimeout(() => setProblem(null), 8000);
    return () => clearTimeout(t);
  }, [problem]);
  const report: Report = (work) => {
    setProblem(null);
    work.catch((e: unknown) => {
      later.current = null; // a change that never started leaves nothing to announce or focus
      setProblem(e instanceof Error ? e.message : 'Could not save your sidebar. Try again.');
    });
  };

  const open = openChannelName(pathname);
  const arranged = useMemo(
    () => arrangeSidebar({ groups: feed.groups, prefs, unreadOf: (c) => unread[c.id] ?? c.unread, openName: open, now: Date.now() }),
    [feed.groups, prefs, unread, open],
  );
  // Every group of the team in the person's order (shown or not) and the ones shown: moving works on the shown ones and leaves the others where they are.
  const fullOrder = useMemo(() => shownGroupIds(feed.groups, prefs.groupOrder), [feed.groups, prefs.groupOrder]);
  const shown = useMemo(() => arranged.groups.map((g) => g.id), [arranged.groups]);

  // What to do once a change has been drawn: put keyboard focus back on the element that moved, and say what happened for a screen reader.
  const root = useRef<HTMLDivElement>(null);
  const notify: Notify = (note) => {
    later.current = note;
  };
  const [said, setSaid] = useState('');
  useEffect(() => {
    const note = later.current;
    if (!note) return;
    later.current = null;
    if (note.focus) restoreFocus(root.current, note.focus);
    if (note.say) {
      const text = typeof note.say === 'function' ? note.say(arranged) : note.say;
      // the same sentence twice in a row is still announced: a trailing space changes the text
      setSaid((prev) => (prev === text ? `${text} ` : text));
    }
  }, [arranged]);

  const moveGroup = (id: string, step: -1 | 1, note: Note): void => {
    const next = reorderShown(fullOrder, moveId(shown, id, step));
    if (next.join() === fullOrder.join()) return;
    notify(note);
    report(sidebarPrefsStore.update(slug, { groupOrder: next as SidebarPrefs['groupOrder'] }));
  };

  // Dragging a group by its grip. Only a mouse or a pen can drag; the options menu and Alt + arrow do the same for everyone else.
  const [drag, setDrag] = useState<DragState>({ dragging: null, over: null });
  const dragApi = personal && arranged.groups.length >= 2
    ? {
        state: drag,
        start: (id: string, e: DragEvent) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', id);
          const el = (e.currentTarget as HTMLElement).closest('.group');
          if (el) e.dataTransfer.setDragImage(el, 12, 12);
          setDrag({ dragging: id, over: null });
        },
        over: (id: string, e: DragEvent) => {
          if (!drag.dragging || drag.dragging === id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const after = e.clientY > box.top + box.height / 2;
          if (drag.over?.id !== id || drag.over.after !== after) setDrag({ dragging: drag.dragging, over: { id, after } });
        },
        drop: (id: string, e: DragEvent) => {
          if (!drag.dragging) return;
          e.preventDefault();
          const after = drag.over?.id === id ? drag.over.after : false;
          const dragged = drag.dragging;
          const next = reorderShown(fullOrder, dropId(shown, dragged, id, after));
          setDrag({ dragging: null, over: null });
          if (next.join() === fullOrder.join()) return;
          const name = arranged.groups.find((g) => g.id === dragged)?.name ?? 'group';
          notify({ say: `Moved group ${name}` });
          report(sidebarPrefsStore.update(slug, { groupOrder: next as SidebarPrefs['groupOrder'] }));
        },
        end: () => setDrag({ dragging: null, over: null }),
        move: (id: string, name: string, step: -1 | 1) => moveGroup(id, step, { focus: { group: id }, say: `Moved group ${name} ${step < 0 ? 'up' : 'down'}` }),
      }
    : null;

  const rowProps = (c: NavChannel): RowProps => {
    const count = unread[c.id] ?? c.unread;
    return {
      slug,
      channel: c,
      count,
      look: unreadLook(count, levels, c.id, 'channel'),
      starred: isStarred(prefs.starred, c.id),
      personal,
      stars: prefs.starred,
      report,
      notify,
      setProblem,
    };
  };

  // The list draws at once with what is known (the defaults until the person's own view arrives, which only changes the order and adds the
  // controls); it never waits on the request.
  const starredGroup: ArrangedGroup | null = arranged.starred.length > 0 ? { id: 'starred', name: 'Starred', channels: arranged.starred, hidden: [] } : null;
  const hasGroups = starredGroup !== null || arranged.groups.length > 0;
  return (
    <div className={`channel-groups ${personal && hasGroups ? 'sb-has-opts' : ''}`} data-slot="channel-groups" ref={root}>
      {guest && feed.status !== 'loading' && feed.groups.length === 0 ? <p className="side-note">Nothing has been shared with you yet.</p> : null}
      {personal && hasGroups ? (
        <div className="sb-opts-pin">
          <ListOptions slug={slug} prefs={prefs} groups={arranged.groups.map((g) => ({ id: g.id, name: g.name }))} report={report} notify={notify} onMove={moveGroup} />
        </div>
      ) : null}
      {starredGroup ? (
        <Group
          group={starredGroup}
          slug={slug}
          open={!collapsed.has('starred')}
          onToggle={() => setCollapsed((c) => flip(c, 'starred'))}
          drag={null}
          rowProps={rowProps}
          revealed={false}
          onReveal={() => undefined}
        />
      ) : null}
      {arranged.groups.map((g) => (
        <Group
          key={g.id}
          group={g}
          slug={slug}
          open={!collapsed.has(g.id)}
          onToggle={() => setCollapsed((c) => flip(c, g.id))}
          drag={dragApi}
          rowProps={rowProps}
          revealed={revealed.has(g.id)}
          onReveal={() => setRevealed((r) => flip(r, g.id))}
        />
      ))}
      {mayCreate ? (
        <div className="nc-row">
          <button type="button" className="it nc-btn" aria-haspopup="dialog" data-testid="new-channel" onClick={() => setCreatingIn(slug)}>
            <span className="h" aria-hidden="true"><AddIcon size={14} /></span>
            <span className="it-label">New channel</span>
          </button>
        </div>
      ) : null}
      <p className="sr-only" role="status" data-testid="sidebar-status">{said}</p>
      {problem ? <p className="sb-problem" role="alert" data-testid="sidebar-problem">{problem}</p> : null}
      {creatingIn === slug ? <NewChannelDialog slug={slug} onClose={() => setCreatingIn(null)} /> : null}
    </div>
  );
}
