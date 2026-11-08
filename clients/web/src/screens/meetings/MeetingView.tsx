import { useParams, useSearchParams } from 'react-router';
import { PageHeader } from '../../components/PageHeader';

/**
 * The page of one finished voice room at /meetings/:meetingId (PLAN P15-20, decision C22): title, date, length, people, links to the transcript, the notes, the thread and
 * the recording, the decisions and action items, Share and Save to team. `?t=<ms>` jumps to a line of the transcript. Work package W3 builds it; until then it says so.
 */
export function MeetingView() {
  const { meetingId } = useParams();
  const [params] = useSearchParams();
  const at = params.get('t');
  return (
    <div className="meeting-view" data-meeting-id={meetingId} data-at-ms={at ?? undefined}>
      <PageHeader title="Meeting" description="Coming in this bundle." />
    </div>
  );
}
