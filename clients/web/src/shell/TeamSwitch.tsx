import { useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { isAdmin, useSession } from '../app/session';
import { useShell } from './context';
import { CaretIcon } from './icons';
import { teamSwitchPath } from './nav';
import { useDismiss } from './useDismiss';

/** Team switcher: shows the current team; the menu lists the person's teams and keeps the section they are in. */
export function TeamSwitch() {
  const session = useSession();
  const { teams, team, teamsLoading, guest } = useShell();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);

  const name = team?.name ?? (teamsLoading ? '' : guest ? 'Shared with you' : 'No team');
  if (guest) {
    return (
      <div className="team" data-guest>
        <div className="team-text">
          <small>Team</small>
          <b>{name}</b>
        </div>
      </div>
    );
  }
  return (
    <div className="team-wrap" ref={box}>
      <button type="button" className="team" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="team-text">
          <small>Team</small>
          <b>{name || ' '}</b>
        </span>
        <span className="car"><CaretIcon open /></span>
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="Teams">
          {teams.map((t) => (
            <Link
              key={t.slug}
              role="menuitemradio"
              aria-checked={t.slug === team?.slug}
              className={`menu-item ${t.slug === team?.slug ? 'on' : ''}`}
              to={teamSwitchPath(loc.pathname, t.slug)}
              onClick={() => setOpen(false)}
            >
              {t.name}
            </Link>
          ))}
          {teams.length === 0 ? <p className="menu-note">You are not on a team yet.</p> : null}
          <div className="menu-sep" role="separator" />
          <Link role="menuitem" className="menu-item" to="/teams" onClick={() => setOpen(false)}>
            {isAdmin(session) ? 'Manage teams' : 'All teams'}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
