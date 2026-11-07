import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { signOut } from '../api/endpoints';
import { isAdmin, useSession, useSessionState } from '../app/session';
import { disablePush } from '../notifications/push';
import { DndStrip } from '../presence/DndIndicators';
import { useMyDnd } from '../presence/hooks';
import { PauseDialog, StatusDialog } from '../presence/PresenceDialogs';
import { MyAvatarPicker } from '../avatars/MyAvatarPicker';
import { Avatar } from '../components/ui';
import { useShell } from './context';
import { GearIcon } from './icons';
import { useDismiss } from './useDismiss';

type AccountDialog = 'status' | 'pause' | 'picture';

/** Signs out: turns push off, ends the session, clears it here and goes to the sign-in page. */
function useSignOut(): () => Promise<void> {
  const { setSession } = useSessionState();
  const navigate = useNavigate();
  return async () => {
    try {
      await disablePush();
      await signOut();
    } finally {
      setSession(null);
      navigate('/sign-in', { replace: true });
    }
  };
}

/** The three dialogs the account menu opens (status, pause notifications, profile picture); `null` draws nothing. */
function AccountDialogs({ dialog, onClose }: { dialog: AccountDialog | null; onClose: () => void }) {
  return (
    <>
      {dialog === 'status' ? <StatusDialog onClose={onClose} /> : null}
      {dialog === 'pause' ? <PauseDialog onClose={onClose} /> : null}
      {dialog === 'picture' ? <MyAvatarPicker onClose={onClose} /> : null}
    </>
  );
}

/** The menu rows, shared by the sidebar's popover and the phone's bottom sheet. `done` closes whichever holds them. */
function AccountItems({ done, openDialog, leave }: { done: () => void; openDialog: (d: AccountDialog) => void; leave: () => void }) {
  const session = useSession();
  const { guest } = useShell();
  const dnd = useMyDnd();
  return (
    <>
      <Link role="menuitem" className="menu-item" to="/account/profile" onClick={done}>Account</Link>
      <button type="button" role="menuitem" className="menu-item" data-testid="menu-picture" onClick={() => { done(); openDialog('picture'); }}>Profile picture…</button>
      {dnd.supported ? (
        <>
          <button type="button" role="menuitem" className="menu-item" data-testid="menu-status" onClick={() => { done(); openDialog('status'); }}>Set status…</button>
          <button type="button" role="menuitem" className="menu-item" data-testid="menu-pause" onClick={() => { done(); openDialog('pause'); }}>
            {dnd.banner ? 'Notifications are paused…' : 'Pause notifications…'}
          </button>
          <Link role="menuitem" className="menu-item" to="/account/notifications#status-and-dnd" onClick={done}>Do not disturb settings</Link>
        </>
      ) : null}
      {guest ? null : <Link role="menuitem" className="menu-item" to="/memory" data-testid="menu-my-memory" onClick={done}>Your memory</Link>}
      {guest ? null : <Link role="menuitem" className="menu-item" to="/knowledge" data-testid="menu-my-knowledge" onClick={done}>Your knowledge</Link>}
      {guest ? null : <Link role="menuitem" className="menu-item" to="/teams" onClick={done}>Teams</Link>}
      {isAdmin(session) ? <Link role="menuitem" className="menu-item" to="/settings/workspace/general" onClick={done}>Settings</Link> : null}
      <div className="menu-sep" role="separator" />
      <button type="button" role="menuitem" className="menu-item" onClick={leave}>Sign out</button>
    </>
  );
}

/** Bottom of the sidebar: account menu trigger and who is signed in. */
export function AccountMenu() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const dnd = useMyDnd();
  const signOutNow = useSignOut();
  useDismiss(open, () => setOpen(false), box);
  const closeDialog = (): void => {
    setDialog(null);
    window.setTimeout(() => gear.current?.focus(), 0); // the menu item that opened it is gone: focus returns to the account button
  };
  const leave = (): void => {
    setOpen(false);
    void signOutNow();
  };

  return (
    <>
    <DndStrip />
    <div className="foot" ref={box}>
      <Avatar name={session.person.name} avatar={session.person.avatar} personId={session.person.id} />
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
          <AccountItems done={() => setOpen(false)} openDialog={setDialog} leave={leave} />
        </div>
      ) : null}
    </div>
    <AccountDialogs dialog={dialog} onClose={closeDialog} />
    </>
  );
}

/**
 * The same menu as a bottom sheet, opened by "You" in the phone's bottom bar (P21-23). A press on the scrim behind it, or Esc, closes it; the
 * person's name and picture head it. `onGone` runs when a dialog the sheet opened closes (the bar gives focus back to "You").
 */
export function AccountSheet({ open, onClose, onGone }: { open: boolean; onClose: () => void; onGone: () => void }) {
  const session = useSession();
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const signOutNow = useSignOut();
  useDismiss(open, onClose, sheet);
  useEffect(() => {
    if (open) sheet.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const closeDialog = (): void => {
    setDialog(null);
    onGone();
  };
  return (
    <>
      {open ? (
        <>
          <button type="button" className="bb-scrim" aria-label="Close account menu" tabIndex={-1} onClick={onClose} />
          <div className="bb-sheet" ref={sheet} role="dialog" aria-label="Account" data-testid="account-sheet">
            <div className="bb-sheet-head">
              <Avatar name={session.person.name} avatar={session.person.avatar} personId={session.person.id} />
              <span className="bb-sheet-name">{session.person.name}</span>
            </div>
            <div className="bb-sheet-items" role="menu" aria-label="Account">
              <AccountItems done={onClose} openDialog={setDialog} leave={() => { onClose(); void signOutNow(); }} />
            </div>
          </div>
        </>
      ) : null}
      <AccountDialogs dialog={dialog} onClose={closeDialog} />
    </>
  );
}
