import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { signOut } from '../api/endpoints';
import { isAdmin, useSession, useSessionState } from '../app/session';
import { disablePush } from '../notifications/push';
import { DndStrip } from '../presence/DndIndicators';
import { useMyDnd } from '../presence/hooks';
import { PauseDialog, StatusDialog } from '../presence/PresenceDialogs';
import { useShell } from './context';
import { GearIcon } from './icons';
import { useDismiss } from './useDismiss';

/** Bottom of the sidebar: account menu trigger and who is signed in. */
export function AccountMenu() {
  const session = useSession();
  const { setSession } = useSessionState();
  const { guest } = useShell();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'status' | 'pause' | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const dnd = useMyDnd();
  useDismiss(open, () => setOpen(false), box);
  const closeDialog = (): void => {
    setDialog(null);
    window.setTimeout(() => gear.current?.focus(), 0); // the menu item that opened it is gone: focus returns to the account button
  };

  const leave = async (): Promise<void> => {
    setOpen(false);
    try {
      await disablePush();
      await signOut();
    } finally {
      setSession(null);
      navigate('/sign-in', { replace: true });
    }
  };

  return (
    <>
    <DndStrip />
    <div className="foot" ref={box}>
      <span className="foot-name">{session.person.name}</span>
      {dnd.customStatus ? (
        <span className="foot-status" title={`${dnd.customStatus.emoji ?? ''} ${dnd.customStatus.text}`.trim()} data-testid="foot-status">
          <span aria-hidden="true">{dnd.customStatus.emoji}</span>
          <span className="sr-only">Status: {dnd.customStatus.text || dnd.customStatus.emoji}</span>
        </span>
      ) : null}
      <button
        ref={gear}
        type="button"
        className="icon-btn foot-settings"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
      {open ? (
        <div className="menu menu-up" role="menu" aria-label="Account">
          <Link role="menuitem" className="menu-item" to="/account" onClick={() => setOpen(false)}>Account</Link>
          {dnd.supported ? (
            <>
              <button type="button" role="menuitem" className="menu-item" data-testid="menu-status" onClick={() => { setOpen(false); setDialog('status'); }}>Set status…</button>
              <button type="button" role="menuitem" className="menu-item" data-testid="menu-pause" onClick={() => { setOpen(false); setDialog('pause'); }}>
                {dnd.banner ? 'Notifications are paused…' : 'Pause notifications…'}
              </button>
              <Link role="menuitem" className="menu-item" to="/account#status-and-dnd" onClick={() => setOpen(false)}>Do not disturb settings</Link>
            </>
          ) : null}
          {guest ? null : <Link role="menuitem" className="menu-item" to="/teams" onClick={() => setOpen(false)}>Teams</Link>}
          {isAdmin(session) ? <Link role="menuitem" className="menu-item" to="/settings/workspace/general" onClick={() => setOpen(false)}>Settings</Link> : null}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => void leave()}>Sign out</button>
        </div>
      ) : null}
    </div>
    {dialog === 'status' ? <StatusDialog onClose={closeDialog} /> : null}
    {dialog === 'pause' ? <PauseDialog onClose={closeDialog} /> : null}
    </>
  );
}
