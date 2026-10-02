import { Link, Navigate, useParams } from 'react-router';
import { isAdmin, useSession } from '../app/session';
import { ForbiddenBody } from '../components/states';
import { useShell } from './context';

const LAST_TEAM_KEY = 'manythreads.lastTeam';

export function rememberTeam(slug: string): void {
  try {
    window.localStorage.setItem(LAST_TEAM_KEY, slug);
  } catch {
    /* storage can be blocked; the next visit then opens the first team */
  }
}
export function recalledTeam(): string | null {
  try {
    return window.localStorage.getItem(LAST_TEAM_KEY);
  } catch {
    return null;
  }
}

/** `/`: the Threads of the team the person was last in (the shell picks it), or what to do when there is none. */
export function HomeView() {
  const session = useSession();
  const { team, teamsLoading, guest } = useShell();
  if (teamsLoading) return <div className="view-empty" aria-busy="true" />;
  if (team) return <ThreadsView />;
  return (
    <div className="view-empty">
      <p className="view-empty-title">{guest ? 'Nothing has been shared with you yet' : 'You are not on a team yet'}</p>
      <p className="view-empty-body">
        {guest ? 'Channels you are invited to will show up in the sidebar.' : isAdmin(session) ? 'Create the first team to start working.' : 'A workspace admin or a team lead can add you.'}
      </p>
      {!guest && isAdmin(session) ? <Link className="btn primary" to="/teams">Create a team</Link> : null}
    </div>
  );
}

export function TeamHome() {
  const { team } = useParams();
  return <Navigate to={`/t/${team ?? ''}/threads`} replace />;
}

/** Wraps the team routes: a team the person cannot see is a 403, not an empty shell. */
export function RequireTeam({ children }: { children: React.ReactNode }) {
  const { team, teamsLoading, guest } = useShell();
  if (teamsLoading) return <div className="view-empty" aria-busy="true" />;
  if (!team && !guest) return <div className="view-empty" role="alert"><ForbiddenBody /></div>;
  return <>{children}</>;
}

export function ChannelView() {
  const { channel = '' } = useParams();
  return (
    <div className="view-empty">
      <p className="view-empty-title">{`This is the start of #${channel}.`}</p>
    </div>
  );
}

export function DirectMessageView() {
  return (
    <div className="view-empty">
      <p className="view-empty-title">This is the start of your conversation.</p>
    </div>
  );
}

export function ThreadsView() {
  return (
    <div className="view-empty">
      <p className="view-empty-title">No threads yet</p>
      <p className="view-empty-body">Threads you follow or start show up here.</p>
    </div>
  );
}

const SECTIONS = {
  files: { title: 'No files yet', body: 'Files shared in channels and kept by the team show up here.' },
  boards: { title: 'No boards yet', body: 'Boards the team creates show up here.' },
  approvals: { title: 'Nothing waiting', body: 'Requests that need a person to decide show up here.' },
} as const;

export function SectionView({ section }: { section: keyof typeof SECTIONS }) {
  const s = SECTIONS[section];
  return (
    <div className="view-empty">
      <p className="view-empty-title">{s.title}</p>
      <p className="view-empty-body">{s.body}</p>
    </div>
  );
}
