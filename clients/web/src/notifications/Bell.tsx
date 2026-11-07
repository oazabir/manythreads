import { useRef, useState } from 'react';
import { BellIcon, MoonIcon } from '../shell/icons';
import { useMyDnd } from '../presence/hooks';
import { bellLabel } from '../presence/settingsModel';
import { useDismiss } from '../shell/useDismiss';
import { NotificationList } from './NotificationList';
import { useNotifications } from './useNotifications';

export { useNotifications };

/**
 * The bell in the header and its popover. The red number counts what is addressed to the person (mentions, replies, direct messages,
 * reminders); background news from channels set to "all messages" shows only as a small grey dot (P21-10).
 */
export function Bell() {
  const snap = useNotifications();
  const dnd = useMyDnd();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);

  if (!snap.supported) return null;
  const attention = Math.max(0, snap.unread - snap.activity);
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
        {attention > 0 ? <span className="bell-badge" data-testid="bell-count" data-vt-mask>{attention > 99 ? '99+' : attention}</span> : null}
        {snap.activity > 0 ? <span className={`bell-activity ${attention > 0 ? 'beside' : ''}`} data-testid="bell-activity" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="ntf-pop" role="dialog" aria-label="Notifications" data-testid="notifications-popover">
          <NotificationList mode="panel" onOpened={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
