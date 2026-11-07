import { Link } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { isAdmin, useSession } from '../../app/session';
import { useShell } from '../../shell/context';
import { ScheduledJobsView } from './ScheduledJobsView';

/*
 * Jobs (SPEC §6.5, PLAN P6-08), a screen of its own with a sidebar entry: the timers that put work on the board without a person.
 * A lead or a workspace admin manages them; everyone else sees the schedule and the ledger.
 */
export function ScheduledJobsScreen() {
  const { team, teamSlug } = useShell();
  const session = useSession();
  const slug = team?.slug ?? teamSlug ?? '';
  const canManage = isAdmin(session) || team?.myRole === 'lead';

  return (
    <div className="bd-screen" data-testid="scheduled-jobs-screen">
      <PageHeader title="Jobs" description="Bot work on a schedule: heartbeats, routines and cards that open themselves." />
      {session.role === 'guest' ? null : (
        <p className="d" data-testid="jobs-personal-link">These are the team's jobs. Routines that work for you alone, and write into your own files, are under <Link to="/account/routines">Account, Routines</Link>.</p>
      )}
      <ScheduledJobsView slug={slug} canManage={canManage} />
    </div>
  );
}
