import { useParams } from 'react-router';
import { PageHeader } from '../../components/PageHeader';

/**
 * The page a planned room's link opens, `/join/:scheduledId` (PLAN Bundle D, P16-05, decision D10): the plan's title and time, and Join (or the plain sentence when the person cannot read the
 * channel, the plan was cancelled or has not started). Work package C builds it; until then it says so.
 */
export function JoinScheduled() {
  const { scheduledId } = useParams();
  return (
    <div className="meeting-view" data-scheduled-id={scheduledId}>
      <PageHeader title="Join a meeting" description="Coming in this bundle." />
    </div>
  );
}
