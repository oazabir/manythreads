import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { HomeIcon, PersonIcon } from '@proicons/react';
import { useUnread } from '../channels/hooks';
import { proIcon } from '../components/proicon';
import { useDms } from '../dms/store';
import { usePanel } from '../kernel/panel';
import { levelsStore } from '../notifications/levelsStore';
import { notificationStore } from '../notifications/store';
import { useMyDnd } from '../presence/hooks';
import { AccountSheet } from './AccountMenu';
import { activeEntry, barPath, dmUnreadTotal, takesText } from './bottomBar';
import { useShell } from './context';
import { BellIcon, DmIcon, SearchIcon } from './icons';
import { Pill, type PillTone } from './Pill';

const BarHome = proIcon(HomeIcon, 22);
const BarYou = proIcon(PersonIcon, 22);

/** How long the bar waits to come back after a text box loses the focus (ms). */
const BAR_RETURN_DELAY = 300;

/**
 * True while a text box has the focus: the on-screen keyboard is up and the bar gives its room to the composer. The bar comes back a moment after the
 * focus leaves, not at once: tapping Send takes the focus off the box on the way down, and a bar that returned then would push the composer up under the
 * finger before the tap was over, so the tap would miss the button.
 */
function useTextFocus(): boolean {
  const [typing, setTyping] = useState(() => takesText(document.activeElement));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: FocusEvent): void => {
      clearTimeout(timer);
      setTyping(takesText(e.target as Element | null));
    };
    const off = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => setTyping(takesText(document.activeElement)), BAR_RETURN_DELAY);
    };
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', on);
      document.removeEventListener('focusout', off);
    };
  }, []);
  return typing;
}

/** What each entry's badge shows. Activity counts every unread notification for now (the bell's number); work package C may narrow it to mentions. */
function useBadges(threads: number): Record<'home' | 'messages' | 'activity', { n: number; tone: PillTone; note: string }> {
  const dms = useDms();
  const { unread } = useUnread();
  const levels = useSyncExternalStore(levelsStore.subscribe, levelsStore.snapshot).levels;
  const notes = useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
  useEffect(() => {
    void levelsStore.load();
  }, []);
  return {
    home: { n: threads, tone: 'unread', note: 'unread threads' },
    messages: { n: dmUnreadTotal(dms.items, unread, levels), tone: 'mention', note: 'unread messages' },
    activity: { n: notes.unread, tone: 'mention', note: 'unread' },
  };
}

function Badge({ n, tone, note }: { n: number; tone: PillTone; note: string }) {
  if (n <= 0) return null;
  return (
    <span className="bb-badge">
      <Pill n={n} tone={tone} note={note} />
    </span>
  );
}

/**
 * The phone's bottom bar (P21-23): Home (unread threads), Messages, Activity, Search and You. It is drawn at 760 px and below for a signed-in
 * person with a team, steps aside while a text box has the focus (the keyboard is up) and while a thread covers the screen, and tells the page how
 * much room it takes through `--bottom-bar-h` on the root element (0 when it is away), which the frame pads with so it never covers the composer.
 * Search opens the sidebar drawer on its search box (the /search page has no box of its own on a phone).
 */
export function BottomBar({ slug, onSearch }: { slug: string; onSearch: () => void }) {
  const { counts } = useShell();
  const loc = useLocation();
  const panel = usePanel();
  const typing = useTextFocus();
  const dnd = useMyDnd();
  const badges = useBadges(counts['threads.unread'] ?? 0);
  const [sheet, setSheet] = useState(false);
  const youButton = useRef<HTMLButtonElement>(null);
  const shown = !typing && !panel.open;
  useEffect(() => {
    const root = document.documentElement;
    if (shown) root.dataset['bottomBar'] = 'on';
    else delete root.dataset['bottomBar'];
    return () => {
      delete root.dataset['bottomBar'];
    };
  }, [shown]);
  const active = activeEntry(loc.pathname, slug);
  const link = (entry: 'home' | 'messages' | 'activity', label: string, icon: ReactNode) => (
    <Link to={barPath(slug, entry)} className="bb-item" aria-current={active === entry ? 'page' : undefined} data-active={active === entry ? 'true' : undefined} data-testid={`bar-${entry}`}>
      <span className="bb-ic" aria-hidden="true">{icon}</span>
      <Badge {...badges[entry]} />
      <span className="bb-label">{label}</span>
    </Link>
  );
  return (
    <>
      {shown ? (
        <nav className="bb" aria-label="Main" data-testid="bottom-bar">
          {link('home', 'Home', <BarHome />)}
          {link('messages', 'Messages', <DmIcon size={22} />)}
          {link('activity', 'Activity', <BellIcon size={22} />)}
          <button type="button" className="bb-item" data-testid="bar-search" onClick={onSearch}>
            <span className="bb-ic" aria-hidden="true"><SearchIcon size={22} /></span>
            <span className="bb-label">Search</span>
          </button>
          <button ref={youButton} type="button" className="bb-item" data-testid="bar-you" aria-haspopup="dialog" aria-expanded={sheet} data-active={sheet ? 'true' : undefined} onClick={() => setSheet(true)}>
            <span className="bb-ic" aria-hidden="true">
              <BarYou />
              {dnd.banner ? <span className="bb-dot" data-testid="bar-dnd" /> : null}
            </span>
            <span className="bb-label">You</span>
            {dnd.banner ? <span className="sr-only">Notifications are paused</span> : null}
          </button>
        </nav>
      ) : null}
      <AccountSheet open={sheet} onClose={() => setSheet(false)} onGone={() => window.setTimeout(() => youButton.current?.focus(), 0)} />
    </>
  );
}
