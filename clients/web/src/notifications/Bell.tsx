import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Notification as InboxItem } from '@manythreads/shared';
import { useOpenMessage } from '../shell/messageLink';
import { BellIcon, ClockIcon, HashIcon, MailIcon, MentionIcon, MoonIcon, ReplyIcon } from '../shell/icons';
import { useMyDnd } from '../presence/hooks';
import { PausedNote, resumeNow, useSaver } from '../presence/PresencePanels';
import { bellLabel } from '../presence/settingsModel';
import { useDismiss } from '../shell/useDismiss';
import { browserAlerts, notificationStore, notificationTitle } from './store';
import { ago } from '../channels/format';
import { forTab, groupByDay, type BellTab } from './model';

export function useNotifications() {
  return useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
}

const GLYPH: Record<InboxItem['kind'], ReactNode> = { mention: <MentionIcon />, reply: <ReplyIcon />, dm: <MailIcon />, message: <HashIcon />, reminder: <ClockIcon /> };

function Item({ n, onOpen }: { n: InboxItem; onOpen: (n: InboxItem) => void }) {
  const unread = n.readAt === null;
  return (
    <li className="ntf-li">
      <button type="button" className={`ntf ${unread ? 'unread' : ''}`} data-testid="notification" data-kind={n.kind} data-unread={unread} onClick={() => onOpen(n)}>
        <span className="ntf-ic" aria-hidden="true">{GLYPH[n.kind]}</span>
        <span className="ntf-main">
          <span className="ntf-title">{notificationTitle(n)}</span>
          <span className="ntf-preview">{n.preview}</span>
        </span>
        <span className="ntf-time" data-vt-mask>{ago(n.createdAt)}</span>
        {unread ? <span className="ntf-dot" aria-hidden="true" /> : null}
      </button>
    </li>
  );
}

/** "Allow browser alerts?": asks the browser once, then stores the choice as the person's setting. Absent where there is no Notification API. */
function AlertsRow({ prefsOn, prefsKnown }: { prefsOn: boolean; prefsKnown: boolean }) {
  const [state, setState] = useState(browserAlerts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state === 'unsupported' || state === 'denied') return null;
  if (state === 'granted' && (prefsOn || !prefsKnown)) return null;
  const allow = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let result = state;
      if (state === 'default') result = (await Notification.requestPermission()) as typeof state;
      setState(browserAlerts());
      if (result === 'granted') await notificationStore.setBrowserAlerts(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn alerts on.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ntf-allow" data-testid="allow-alerts">
      <span>Allow browser alerts?</span>
      <button type="button" className="btn s" disabled={busy} onClick={() => void allow()}>Allow</button>
      {error ? <span className="ntf-error" role="alert">{error}</span> : null}
    </div>
  );
}

/** The bell in the header: unread count, and the popover (Notifications · Mark all; mention, reply and DM items; the alerts row). */
export function Bell() {
  const snap = useNotifications();
  const openMessage = useOpenMessage();
  const dnd = useMyDnd();
  const resume = useSaver();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<BellTab>('unread');
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);

  useEffect(() => {
    if (!open) return;
    void notificationStore.loadItems();
    void notificationStore.loadPrefs();
    void notificationStore.refreshSummary();
  }, [open]);

  if (!snap.supported) return null;
  const shown = forTab(snap.items, tab);
  const prefsOn = snap.prefs !== null && (snap.prefs.mention.browser || snap.prefs.reply.browser || snap.prefs.dm.browser);

  const go = (n: InboxItem): void => {
    setOpen(false);
    void notificationStore.markRead([n.id]);
    void openMessage({ channelId: n.channelId, channelKind: n.channelKind, channelName: n.channelName, messageId: n.refId, threadRootId: n.threadRootId });
  };
  return (
    <div className="bell" ref={box}>
      <button
        type="button"
        className="icon-btn bell-btn"
        aria-label={bellLabel(snap.unread, dnd.banner)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="bell"
        data-paused={dnd.banner ? dnd.banner.reason : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <BellIcon />
        {dnd.banner ? <span className="bell-moon" data-testid="bell-paused" aria-hidden="true"><MoonIcon /></span> : null}
        {snap.unread > 0 ? <span className="bell-badge" data-testid="bell-count" data-vt-mask>{snap.unread > 99 ? '99+' : snap.unread}</span> : null}
      </button>
      {open ? (
        <div className="ntf-pop" role="dialog" aria-label="Notifications" data-testid="notifications-popover">
          <header className="ntf-head">
            <b>Notifications</b>
            <button type="button" className="btn s" disabled={snap.unread === 0} onClick={() => void notificationStore.markRead()}>Mark all read</button>
          </header>
          <div className="ntf-tabs" role="group" aria-label="Show">
            <button type="button" className="ntf-tab" aria-pressed={tab === 'unread'} onClick={() => setTab('unread')}>Unread</button>
            <button type="button" className="ntf-tab" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>All</button>
          </div>
          {dnd.banner ? (
            <div className="ntf-paused">
              <PausedNote banner={dnd.banner} onResume={() => void resume.run(resumeNow)} busy={resume.busy} error={resume.error}>
                {dnd.banner.canResume ? null : <Link className="link-btn" to="/account#status-and-dnd" onClick={() => setOpen(false)}>Change</Link>}
              </PausedNote>
            </div>
          ) : null}
          {snap.itemsStatus === 'loading' || snap.itemsStatus === 'idle' ? (
            <p className="ntf-note" aria-busy="true">Loading…</p>
          ) : snap.itemsStatus === 'error' ? (
            <p className="ntf-note" role="alert">Could not load notifications. <button type="button" className="link-btn" onClick={() => void notificationStore.loadItems()}>Try again</button></p>
          ) : shown.length === 0 ? (
            <p className="ntf-note" data-testid="notifications-empty">{tab === 'unread' && snap.items.length > 0 ? 'You are all caught up. Switch to All to see earlier ones.' : 'You are all caught up.'}</p>
          ) : (
            <div className="ntf-list">
              {groupByDay(shown, new Date()).map((g) => (
                <section key={g.day} aria-label={g.day}>
                  <h3 className="ntf-day">{g.day}</h3>
                  <ul className="ntf-group">{g.items.map((n) => <Item key={n.id} n={n} onOpen={go} />)}</ul>
                </section>
              ))}
            </div>
          )}
          <AlertsRow prefsOn={prefsOn} prefsKnown={snap.prefs !== null} />
        </div>
      ) : null}
    </div>
  );
}
