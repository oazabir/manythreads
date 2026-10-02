import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Notification as InboxItem } from '@manythreads/shared';
import { useOpenMessage } from '../shell/messageLink';
import { BellIcon } from '../shell/icons';
import { useDismiss } from '../shell/useDismiss';
import { browserAlerts, notificationStore, notificationTitle } from './store';
import { ago } from '../channels/format';

export function useNotifications() {
  return useSyncExternalStore(notificationStore.subscribe, notificationStore.snapshot);
}

const GLYPH: Record<InboxItem['kind'], string> = { mention: '@', reply: '↳', dm: '✉' };

function Item({ n, onOpen }: { n: InboxItem; onOpen: (n: InboxItem) => void }) {
  const unread = n.readAt === null;
  return (
    <li>
      <button type="button" className={`ntf ${unread ? 'unread' : ''}`} data-testid="notification" data-kind={n.kind} data-unread={unread} onClick={() => onOpen(n)}>
        <span className="ntf-ic" aria-hidden="true">{GLYPH[n.kind]}</span>
        <span className="ntf-main">
          <span className="ntf-title">{notificationTitle(n)}</span>
          <span className="ntf-preview">{n.preview}</span>
        </span>
        <span className="ntf-time" data-vt-mask>{ago(n.createdAt)}</span>
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
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);

  useEffect(() => {
    if (!open) return;
    void notificationStore.loadItems();
    void notificationStore.loadPrefs();
    void notificationStore.refreshSummary();
  }, [open]);

  if (!snap.supported) return null;
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
        aria-label={snap.unread > 0 ? `Notifications, ${snap.unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="bell"
        onClick={() => setOpen((o) => !o)}
      >
        <BellIcon />
        {snap.unread > 0 ? <span className="bell-badge" data-testid="bell-count" data-vt-mask>{snap.unread > 99 ? '99+' : snap.unread}</span> : null}
      </button>
      {open ? (
        <div className="ntf-pop" role="dialog" aria-label="Notifications" data-testid="notifications-popover">
          <header className="ntf-head">
            <b>Notifications</b>
            <button type="button" className="link-btn" disabled={snap.unread === 0} onClick={() => void notificationStore.markRead()}>Mark all</button>
          </header>
          {snap.itemsStatus === 'loading' || snap.itemsStatus === 'idle' ? (
            <p className="ntf-note" aria-busy="true">Loading…</p>
          ) : snap.itemsStatus === 'error' ? (
            <p className="ntf-note" role="alert">Could not load notifications. <button type="button" className="link-btn" onClick={() => void notificationStore.loadItems()}>Try again</button></p>
          ) : snap.items.length === 0 ? (
            <p className="ntf-note" data-testid="notifications-empty">You are all caught up.</p>
          ) : (
            <ul className="ntf-list">{snap.items.map((n) => <Item key={n.id} n={n} onOpen={go} />)}</ul>
          )}
          <AlertsRow prefsOn={prefsOn} prefsKnown={snap.prefs !== null} />
        </div>
      ) : null}
    </div>
  );
}
