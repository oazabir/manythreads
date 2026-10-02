import { Link, Navigate, useParams } from 'react-router';
import { dmLabel, useDms } from '../dms/store';
import { ChannelBody, NoChannelAccess } from '../screens/ChannelView';
import { useChannelFeed } from './channelFeed';
import { GUEST_SLUG } from './messageLink';
import { channelPath } from './nav';
import { isAdmin, useSession } from '../app/session';
import { ForbiddenBody } from '../components/states';
import { useShell } from './context';
import { ThreadsInbox } from '../screens/ThreadsInbox';

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
  const feed = useChannelFeed(guest ? GUEST_SLUG : null);
  if (teamsLoading || (guest && feed.status === 'loading')) return <div className="view-empty" aria-busy="true" />;
  if (team) return <ThreadsInbox />;
  // a guest has no Threads: the first channel they were granted is their home
  const first = guest ? feed.groups.flatMap((g) => g.channels)[0] : undefined;
  if (first) return <Navigate to={channelPath(GUEST_SLUG, first.name)} replace />;
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

/** `/t/:team/dm/:id`: a conversation, drawn with the channel view and the composer. */
export function DirectMessageView() {
  const { id = '' } = useParams();
  const { team, teamSlug } = useShell();
  const session = useSession();
  const feed = useDms();
  const slug = team?.slug ?? teamSlug ?? '';
  if (feed.status === 'loading') return <div className="view-empty" aria-busy="true" />;
  const dm = feed.items.find((d) => d.channel.id === id);
  if (!dm) return <NoChannelAccess />;
  return <ChannelBody key={dm.channel.id} channelId={dm.channel.id} name="" teamSlug={slug} dm={{ label: dmLabel(dm, session.person.id) }} />;
}
const SECTIONS = {
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
