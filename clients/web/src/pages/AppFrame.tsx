import { Link } from 'react-router';
import { isAdmin, useSession } from '../app/session';

/** App frame (PLAN Phase 1 §2): left rail, centre column, hidden right panel. The header names the workspace. */
export function AppFrame() {
  const session = useSession();
  return (
    <div className="frame" data-testid="app-frame">
      <aside className="rail">
        <div className="region team-switch" data-landmark="team-switch" />
        <div className="region search" data-landmark="search" />
        <nav className="region sidebar" data-landmark="sidebar" />
      </aside>
      <main className="center">
        <header className="region header app-head" data-landmark="header">
          <h1 className="app-head-name">{session.workspace.name}</h1>
          <nav className="app-head-links" aria-label="Main">
            <Link to="/teams">Teams</Link>
            {isAdmin(session) ? <Link to="/settings/workspace/general">Settings</Link> : null}
            <Link to="/account">{session.person.name}</Link>
          </nav>
        </header>
        <section className="region content" data-landmark="content" />
      </main>
      <aside className="region right-panel" data-landmark="right-panel" hidden />
    </div>
  );
}
