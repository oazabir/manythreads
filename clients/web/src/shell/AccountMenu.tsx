import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { signOut } from '../api/endpoints';
import { isAdmin, useSession, useSessionState } from '../app/session';
import { Avatar } from '../components/ui';
import { useShell } from './context';
import { GearIcon } from './icons';
import { useDismiss } from './useDismiss';

/** Bottom of the sidebar: who is signed in, and the account menu. */
export function AccountMenu() {
  const session = useSession();
  const { setSession } = useSessionState();
  const { guest } = useShell();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);

  const leave = async (): Promise<void> => {
    setOpen(false);
    try {
      await signOut();
    } finally {
      setSession(null);
      navigate('/sign-in', { replace: true });
    }
  };

  return (
    <div className="foot" ref={box}>
      <Avatar name={session.person.name} />
      <span className="foot-name">{session.person.name}</span>
      <button type="button" className="icon-btn foot-gear" aria-label="Account menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <GearIcon />
      </button>
      {open ? (
        <div className="menu menu-up" role="menu" aria-label="Account">
          <Link role="menuitem" className="menu-item" to="/account" onClick={() => setOpen(false)}>Account</Link>
          {guest ? null : <Link role="menuitem" className="menu-item" to="/teams" onClick={() => setOpen(false)}>Teams</Link>}
          {isAdmin(session) ? <Link role="menuitem" className="menu-item" to="/settings/workspace/general" onClick={() => setOpen(false)}>Settings</Link> : null}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => void leave()}>Sign out</button>
        </div>
      ) : null}
    </div>
  );
}
