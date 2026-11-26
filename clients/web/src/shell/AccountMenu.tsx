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
import { AppearanceEntry } from './AppearanceMenu';
import { GearIcon } from './icons';
import { MENU_SCOPE, onMenuKeys } from './menuNav';
import { useDismiss } from './useDismiss';
import { useNarrow } from './useNarrow';
import { useBookmarkTotal } from '../bookmarks/store';

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
  const { guest, team, teamSlug } = useShell();
  const dnd = useMyDnd();
  const narrow = useNarrow();
  // on a phone the You sheet has Bookmarks too (P36-08), while the person has one: the full page, which the header button's panel also links to as "Open as a page"
  // (P37-08; the sidebar entry it once copied is gone). The header button loads the store.
  const bookmarks = useBookmarkTotal();
  // the team in sight; a guest's shell takes any slug in the address, else the guests' `shared` (as bookmarks/useBookmarksSlug.ts, which this file does not import: it pulls in the whole composer)
  const bookmarksHref = `/t/${encodeURIComponent(team?.slug ?? teamSlug ?? 'shared')}/bookmarks`;
  const [appearance, setAppearance] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // on a phone the Appearance submenu takes the place of the rows (with a Back row); on a wide screen it is a flyout and the rows stay
  const rows = !(narrow && appearance);
  return (
    <div className="am-wrap" ref={wrap}>
      {rows ? (
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
          {narrow && bookmarks > 0 ? <Link role="menuitem" className="menu-item" to={bookmarksHref} data-testid="menu-bookmarks" onClick={done}>Bookmarks</Link> : null}
          {guest ? null : <Link role="menuitem" className="menu-item" to="/memory" data-testid="menu-my-memory" onClick={done}>Your memory</Link>}
          {guest ? null : <Link role="menuitem" className="menu-item" to="/knowledge" data-testid="menu-my-knowledge" onClick={done}>Your knowledge</Link>}
          {guest ? null : <Link role="menuitem" className="menu-item" to="/teams" onClick={done}>Teams</Link>}
          {isAdmin(session) ? <Link role="menuitem" className="menu-item" to="/settings/workspace/general" onClick={done}>Settings</Link> : null}
        </>
      ) : null}
      <AppearanceEntry open={appearance} setOpen={setAppearance} narrow={narrow} done={done} wrap={wrap} />
      {rows ? (
        <>
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={leave}>Sign out</button>
        </>
      ) : null}
    </div>
  );
}

/** Bottom of the sidebar: account menu trigger and who is signed in. */
export function AccountMenu() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const dnd = useMyDnd();
  const signOutNow = useSignOut();
  // closing from inside the menu puts focus back on the gear, so the keyboard carries on from where it was
  const close = (): void => {
    if (box.current?.contains(document.activeElement)) gear.current?.focus();
    setOpen(false);
  };
  useDismiss(open, close, box);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [open]);
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
        data-testid="account-gear"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
      {open ? (
        <div className="menu menu-up" role="menu" aria-label="Account" ref={menu} {...{ [MENU_SCOPE]: '' }} onKeyDown={(e) => onMenuKeys(e, close)}>
          <AccountItems done={close} openDialog={setDialog} leave={leave} />
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
    if (open) sheet.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
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
            <div className="bb-sheet-items" role="menu" aria-label="Account" {...{ [MENU_SCOPE]: '' }} onKeyDown={(e) => onMenuKeys(e, onClose)}>
              <AccountItems done={onClose} openDialog={setDialog} leave={() => { onClose(); void signOutNow(); }} />
            </div>
          </div>
        </>
      ) : null}
      <AccountDialogs dialog={dialog} onClose={closeDialog} />
    </>
  );
}
