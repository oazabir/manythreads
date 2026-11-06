import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { isAdmin, useSession } from '../app/session';
import { useShell } from './context';
import { CaretIcon } from './icons';
import { teamSwitchPath } from './nav';
import { useDismiss } from './useDismiss';

/** The letter a team shows in its mark. */
const markOf = (name: string): string => name.trim().slice(0, 1).toUpperCase() || '·';

/** Alt+1..9 jumps to the Nth team, unless the person is typing. */
export function teamIndexForKey(e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>): number | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const m = /^Digit([1-9])$/.exec(e.code);
  return m?.[1] ? Number(m[1]) - 1 : null;
}

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** True when the key press happened in something the person types into. */
export function isEditableTarget(target: unknown): boolean {
  const el = target as { closest?: (s: string) => unknown } | null;
  return typeof el?.closest === 'function' && Boolean(el.closest(EDITABLE));
}

/** Team switcher: shows the current team; the menu lists the person's teams and keeps the section they are in. */
export function TeamSwitch() {
  const session = useSession();
  const { teams, team, teamsLoading, guest } = useShell();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const navigate = useNavigate();
  useEffect(() => {
    if (guest) return;
    const onKey = (e: KeyboardEvent): void => {
      const i = teamIndexForKey(e);
      const t = i === null ? undefined : teams[i];
      if (!t || e.repeat || isEditableTarget(e.target)) return;
      e.preventDefault();
      void navigate(teamSwitchPath(loc.pathname, t.slug));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [guest, teams, loc.pathname, navigate]);

  const name = team?.name ?? (teamsLoading ? '' : guest ? 'Shared with you' : 'No team');
  if (guest) {
    return (
      <div className="team" data-guest>
        <span className="team-mark" aria-hidden="true">{markOf(name)}</span>
        <div className="team-text">
          <b>{name}</b>
        </div>
      </div>
    );
  }
  return (
    <div className="team-wrap" ref={box}>
      <button type="button" className="team" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="team-mark" aria-hidden="true">{markOf(name)}</span>
        <span className="team-text">
          <b>{name || ' '}</b>
        </span>
        <span className="car"><CaretIcon open /></span>
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="Teams">
          <p className="menu-note menu-head">{session.workspace.name}</p>
          {teams.map((t, i) => (
            <Link
              key={t.slug}
              role="menuitemradio"
              aria-checked={t.slug === team?.slug}
              className={`menu-item ${t.slug === team?.slug ? 'on' : ''}`}
              to={teamSwitchPath(loc.pathname, t.slug)}
              onClick={() => setOpen(false)}
            >
              <span className="team-mark" aria-hidden="true">{markOf(t.name)}</span>
              <span className="it-label">{t.name}</span>
              {i < 9 ? <kbd className="menu-key" title={`Alt+${i + 1} switches to this team`}>{`Alt+${i + 1}`}</kbd> : null}
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
