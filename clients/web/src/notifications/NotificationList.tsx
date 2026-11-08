import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Notification as InboxItem } from '@manythreads/shared';
import { ActorAvatar } from '../components/ActorAvatar';
import { EmptyState } from '../components/EmptyState';
import { SkeletonRows } from '../components/Skeleton';
import { ago, fullStamp } from '../channels/format';
import { PausedNote, resumeNow, useSaver } from '../presence/PresencePanels';
import { useMyDnd } from '../presence/hooks';
import { useOpenMessage } from '../shell/messageLink';
import { BellIcon, MarkReadIcon } from '../shell/icons';
import { AlertsRow } from './AlertsRow';
import { forTab, groupByDay, type BellTab } from './model';
import { notificationStore, notificationTitle } from './store';
import { useNotifications } from './useNotifications';

/** One notification: the sender's picture, what happened (bold while unread), the quoted line (up to three lines), when, and Mark read / Open on hover. */
function Item({ n, onOpen, onRead }: { n: InboxItem; onOpen: (n: InboxItem) => void; onRead: (n: InboxItem) => void }) {
  const unread = n.readAt === null;
  return (
    <li className="ntf-li">
      <button type="button" className={`ntf ${unread ? 'unread' : ''}`} data-testid="notification" data-kind={n.kind} data-unread={unread} onClick={() => onOpen(n)}>
        <span className="ntf-av"><ActorAvatar actorId={n.actorId} name={n.actorName} /></span>
        <span className="ntf-main">
          <span className="ntf-title">{notificationTitle(n)}</span>
          <span className="ntf-preview">{`“${n.preview}”`}</span>
        </span>
        <span className="ntf-time" data-vt-mask title={fullStamp(n.createdAt)}>{ago(n.createdAt)}</span>
        {unread ? <span className="ntf-dot" aria-hidden="true" /> : null}
      </button>
      <span className="ntf-acts">
        {unread ? (
          <button type="button" className="ntf-act" data-testid="notification-mark-read" onClick={() => onRead(n)}>
            <MarkReadIcon /> Mark read
          </button>
        ) : null}
        <button type="button" className="ntf-act" data-testid="notification-open" onClick={() => onOpen(n)}>Open</button>
      </span>
    </li>
  );
}

/**
 * The notifications themselves, in the bell's popover (`mode="panel"`) and on the Activity page (`mode="page"`): Mark all read, the Unread and All
 * tabs, the day groups, the browser-alerts row. The page already has its own heading, so it leaves the "Notifications" title out.
 * `onOpened` runs when an item is opened (the popover closes itself there).
 */
export function NotificationList({ mode, onOpened }: { mode: 'panel' | 'page'; onOpened?: () => void }) {
  const snap = useNotifications();
  const openMessage = useOpenMessage();
  const navigate = useNavigate();
  const dnd = useMyDnd();
  const resume = useSaver();
  const [tab, setTab] = useState<BellTab>('unread');

  useEffect(() => {
    void notificationStore.loadItems();
    void notificationStore.loadPrefs();
    void notificationStore.refreshSummary();
  }, []);

  const shown = forTab(snap.items, tab);
  const prefsOn = snap.prefs !== null && (snap.prefs.mention.browser || snap.prefs.reply.browser || snap.prefs.dm.browser);
  const open = (n: InboxItem): void => {
    onOpened?.();
    void notificationStore.markRead([n.id]);
    // Action items from a meeting point at the meeting, not at a message.
    if (n.refType === 'meeting') {
      void navigate(`/meetings/${n.refId}`);
      return;
    }
    void openMessage({ channelId: n.channelId, channelKind: n.channelKind, channelName: n.channelName, messageId: n.refId, threadRootId: n.threadRootId });
  };
  const read = (n: InboxItem): void => void notificationStore.markRead([n.id]);

  const empty = (): React.ReactNode => {
    const someHidden = tab === 'unread' && snap.items.length > 0;
    return (
      <div className="ntf-empty">
        <EmptyState
          icon={BellIcon}
          testId="notifications-empty"
          title={someHidden && snap.unread > 0 ? 'Nothing unread in the latest ones' : 'You are all caught up'}
          {...(someHidden ? { action: { label: 'Show all', onClick: () => setTab('all') } } : {})}
        >
          {someHidden ? (snap.unread > 0 ? 'Switch to All to see them.' : 'Switch to All to see earlier ones.') : 'Mentions, replies and messages for you will show up here.'}
        </EmptyState>
      </div>
    );
  };

  return (
    <>
      <header className="ntf-head">
        {mode === 'panel' ? <b>Notifications</b> : <span />}
        <button type="button" className="btn s" disabled={snap.unread === 0} onClick={() => void notificationStore.markRead()}>Mark all read</button>
      </header>
      <div className="ntf-tabs" role="group" aria-label="Show">
        <button type="button" className="ntf-tab" aria-pressed={tab === 'unread'} onClick={() => setTab('unread')}>Unread</button>
        <button type="button" className="ntf-tab" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>All</button>
      </div>
      {dnd.banner ? (
        <div className="ntf-paused">
          <PausedNote banner={dnd.banner} onResume={() => void resume.run(resumeNow)} busy={resume.busy} error={resume.error}>
            {dnd.banner.canResume ? null : <Link className="link-btn" to="/account#status-and-dnd" onClick={() => onOpened?.()}>Change</Link>}
          </PausedNote>
        </div>
      ) : null}
      {snap.itemsStatus === 'loading' || snap.itemsStatus === 'idle' ? (
        <SkeletonRows rows={mode === 'page' ? 6 : 4} avatar label="Loading notifications" />
      ) : snap.itemsStatus === 'error' ? (
        <p className="ntf-note" role="alert">Could not load notifications. <button type="button" className="link-btn" onClick={() => void notificationStore.loadItems()}>Try again</button></p>
      ) : shown.length === 0 ? (
        empty()
      ) : (
        <div className="ntf-list">
          {groupByDay(shown, new Date()).map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h3 className="ntf-day">{g.day}</h3>
              <ul className="ntf-group">{g.items.map((n) => <Item key={n.id} n={n} onOpen={open} onRead={read} />)}</ul>
            </section>
          ))}
        </div>
      )}
      <AlertsRow prefsOn={prefsOn} prefsKnown={snap.prefs !== null} />
    </>
  );
}
